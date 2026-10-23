import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { config } from "./config.js";
import { approvalGate } from "./approvals.js";
import { runTurn } from "./harness.js";
import { listTools } from "./tools.js";
import { store } from "./store.js";
import {
  createConversation,
  deleteConversation,
  health,
  listTargets,
  syncLocalToolsToAgent,
} from "./foundry.js";
import { defaultTarget, parseTargetId, targetId } from "./targets.js";
import type { ApprovalDecision, HarnessEvent } from "./protocol.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

/** In-flight turns, so the UI can stop one. */
const inFlight = new Map<string, AbortController>();

/* ─────────────────────────────── status ──────────────────────────── */

app.get("/api/health", async (_req, res) => {
  res.json({
    ...(await health()),
    autoApprove: config.approvals.autoApprove,
    shellEnabled: config.shell.enabled,
    workspaceRoot: config.workspaceRoot,
  });
});

app.get("/api/tools", (_req, res) => {
  res.json(
    listTools().map((t) => ({
      name: t.name,
      description: t.description,
      risk: t.risk,
      autoApproved: config.approvals.autoApprove.includes(t.risk),
    })),
  );
});

app.get("/api/targets", async (_req, res) => {
  try {
    res.json(await listTargets());
  } catch (err: any) {
    res.status(502).json({ error: err?.message ?? String(err) });
  }
});

/* ──────────────────────────── conversations ──────────────────────── */

app.get("/api/conversations", (_req, res) => {
  res.json(store.listConversations());
});

app.post("/api/conversations", async (req, res) => {
  const target = parseTargetId(req.body?.targetId) ?? defaultTarget();
  try {
    const id = await createConversation(target);
    res.json(store.createConversation(id, "New conversation", targetId(target)));
  } catch (err: any) {
    res.status(502).json({ error: err?.message ?? String(err) });
  }
});

app.get("/api/conversations/:id/turns", (req, res) => {
  res.json(store.getTurns(String(req.params.id)));
});

app.delete("/api/conversations/:id", async (req, res) => {
  const id = String(req.params.id);
  const stored = store.getConversation(id);
  const target = parseTargetId(stored?.targetId) ?? defaultTarget();
  try {
    await deleteConversation(id, target);
  } catch (err: any) {
    // Already gone service-side is fine; drop it locally regardless.
    console.warn(`[conversations] remote delete failed for ${id}:`, err?.message ?? err);
  }
  store.deleteConversation(id);
  res.json({ ok: true });
});

/* ───────────────────────────── approvals ─────────────────────────── */

const DECISIONS: ApprovalDecision[] = ["once", "session", "deny"];

app.get("/api/approvals", (req, res) => {
  const sessionId = req.query["sessionId"] ? String(req.query["sessionId"]) : undefined;
  res.json({
    pending: approvalGate.listPending(sessionId),
    sessionGrants: sessionId ? approvalGate.grantsFor(sessionId) : [],
  });
});

app.post("/api/approvals/:approvalId", (req, res) => {
  const decision = String(req.body?.decision ?? "");
  if (!DECISIONS.includes(decision as ApprovalDecision)) {
    res.status(400).json({ error: `decision must be one of ${DECISIONS.join(", ")}` });
    return;
  }
  const ok = approvalGate.resolve(String(req.params.approvalId), decision as ApprovalDecision);
  if (!ok) {
    res.status(409).json({ error: "That approval is unknown or has already been decided." });
    return;
  }
  res.json({ ok: true });
});

app.delete("/api/approvals/grants/:sessionId", (req, res) => {
  approvalGate.revokeGrants(String(req.params.sessionId));
  res.json({ ok: true });
});

/* ────────────────────────────── chat (SSE) ───────────────────────── */

app.post("/api/chat/abort", (req, res) => {
  const sessionId = String(req.body?.sessionId ?? "");
  inFlight.get(sessionId)?.abort();
  approvalGate.denyAll(sessionId);
  res.json({ ok: true });
});

app.post("/api/chat", async (req, res) => {
  const message = String(req.body?.message ?? "").trim();
  const sessionId = String(req.body?.sessionId ?? "default");
  let conversationId = String(req.body?.conversationId ?? "").trim();

  // Explicit target wins; otherwise keep whatever this conversation was last
  // addressed to, so reopening an old thread does not silently switch model.
  const stored = conversationId ? store.getConversation(conversationId) : undefined;
  const target =
    parseTargetId(req.body?.targetId) ?? parseTargetId(stored?.targetId) ?? defaultTarget();

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const emit = (event: HarnessEvent): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Keep intermediaries from closing an idle stream while a human is deciding
  // on an approval prompt, which can legitimately take minutes.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

  const controller = new AbortController();
  inFlight.set(sessionId, controller);
  // `res` close, not `req` close: on a POST the request stream ends as soon as
  // the body has been read, which would abort the turn the instant it began.
  res.on("close", () => controller.abort());

  try {
    if (!conversationId) {
      conversationId = await createConversation(target);
      store.createConversation(conversationId, "New conversation", targetId(target));
    } else if (!store.getConversation(conversationId)) {
      store.createConversation(conversationId, "New conversation", targetId(target));
    } else {
      store.touch(conversationId, { targetId: targetId(target) });
    }
    emit({ type: "conversation", conversationId });

    await runTurn({
      conversationId,
      userText: message,
      sessionId,
      target,
      emit,
      signal: controller.signal,
    });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    const aborted = controller.signal.aborted || /abort/i.test(msg);
    if (!aborted) {
      console.error("[chat]", err);
      emit({ type: "error", message: msg, retryable: isRetryable(err) });
    }
  } finally {
    clearInterval(heartbeat);
    inFlight.delete(sessionId);
    approvalGate.denyAll(sessionId);
    res.end();
  }
});

function isRetryable(err: any): boolean {
  const status = Number(err?.status ?? err?.statusCode ?? 0);
  if (status === 429 || (status >= 500 && status < 600)) return true;
  return /timeout|ECONNRESET|ETIMEDOUT|fetch failed/i.test(String(err?.message ?? ""));
}

/* ─────────────────────── static web build (prod) ─────────────────── */

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, "../../web/dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
}

/* ──────────────────────────────── boot ──────────────────────────── */

const banner = (report: Awaited<ReturnType<typeof health>>): void => {
  console.log(`\n  foundry-desk  ·  http://localhost:${config.port}\n`);
  console.log(`  bind      ${config.host}:${config.port}`);
  console.log(`  project   ${report.endpoint}`);
  console.log(`  agent     ${report.agentName}  (ref mode: ${report.agentRefMode})`);
  console.log(`  workspace ${config.workspaceRoot}`);
  console.log(
    `  tools     ${report.localTools.join(", ") || "none"}${config.shell.enabled ? "" : "  (shell disabled)"}`,
  );
  console.log(`  approve   auto: ${config.approvals.autoApprove.join(", ") || "nothing"}\n`);
  if (config.host !== "127.0.0.1" && config.host !== "localhost" && config.host !== "::1") {
    console.warn(
      `\n  ⚠ Listening on ${config.host}, so anyone who can reach this machine\n` +
        "    can use this harness. It has no sign-in, it runs tools on this\n" +
        "    host, and it holds your Azure credential. Put authentication in\n" +
        "    front of it before leaving this on a shared network.\n",
    );
  }
  if (!report.ok) {
    console.warn(`  ⚠ could not reach the agent: ${report.detail}`);
    console.warn("    Check FOUNDRY_PROJECT_ENDPOINT / FOUNDRY_AGENT_NAME and run `az login`.\n");
  }
};

app.listen(config.port, config.host, async () => {
  try {
    const synced = await syncLocalToolsToAgent();
    if (synced) console.log(`[foundry] published local tools as agent version ${synced.version}`);
  } catch (err: any) {
    console.warn("[foundry] tool sync failed:", err?.message ?? err);
  }
  banner(await health());
});
