#!/usr/bin/env node
/**
 * End-to-end check of the harness against a running server.
 *
 * Exercises the three paths that matter: an auto-approved tool, a tool that
 * pauses for approval and is allowed, and a tool that is denied. Run the server
 * in mock mode first (`FOUNDRY_MOCK=true npm run dev --workspace server`), then
 * `node scripts/smoke.mjs`.
 */

const BASE = process.env.SMOKE_BASE ?? "http://localhost:4399";
const sessionId = `smoke-${Date.now()}`;
let failures = 0;

function check(label, condition, detail = "") {
  const mark = condition ? "✓" : "✗";
  if (!condition) failures++;
  console.log(`  ${mark} ${label}${detail && !condition ? ` — ${detail}` : ""}`);
}

/** Stream one turn, auto-answering approvals with `decide`. */
async function turn(message, { conversationId, decide = null, targetId = null } = {}) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message,
      sessionId,
      ...(conversationId ? { conversationId } : {}),
      ...(targetId ? { targetId } : {}),
    }),
  });
  if (!res.ok) throw new Error(`chat failed: ${res.status}`);

  const events = [];
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (!data) continue;
      const ev = JSON.parse(data);
      events.push(ev);

      if (ev.type === "approval.required" && decide) {
        // Answer out of band, exactly as the UI does, while the stream is open.
        await fetch(`${BASE}/api/approvals/${ev.request.approvalId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: decide }),
        });
      }
    }
  }
  return events;
}

const text = (events) =>
  events.filter((e) => e.type === "text.delta").map((e) => e.delta).join("");
const types = (events) => events.map((e) => e.type);

console.log(`\nfoundry-desk smoke test → ${BASE}\n`);

/* ── 1. health ──────────────────────────────────────────────────── */
console.log("health");
const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
check("server responds", !!health.agentName);
check("reports local tools", Array.isArray(health.localTools) && health.localTools.length > 0);

/* ── 2. auto-approved tool (safe tier) ──────────────────────────── */
console.log("\nauto-approved tool — no prompt expected");
const a = await turn("list the workspace");
const convId = a.find((e) => e.type === "conversation")?.conversationId;
check("conversation created", !!convId);
check("tool was called", types(a).includes("tool.call"));
check("no approval prompt raised", !types(a).includes("approval.required"));
const aResult = a.find((e) => e.type === "tool.result")?.result;
check("tool succeeded", aResult?.ok === true, JSON.stringify(aResult));
check("turn completed", types(a).includes("turn.done"));
check("assistant produced text", text(a).length > 10);

/* ── 3. gated tool, allowed ─────────────────────────────────────── */
console.log("\ngated tool — approval expected, answering “once”");
const b = await turn("write me a note", { conversationId: convId, decide: "once" });
const ask = b.find((e) => e.type === "approval.required");
check("approval prompt raised", !!ask);
check("prompt names the tool", ask?.request?.name === "write_file", ask?.request?.name);
check("prompt carries a preview", !!ask?.request?.preview);
check("risk tier surfaced", ask?.request?.risk === "caution", ask?.request?.risk);
check("decision recorded", b.some((e) => e.type === "approval.resolved" && e.decision === "once"));
const bResult = b.find((e) => e.type === "tool.result")?.result;
check("tool ran after approval", bResult?.ok === true, JSON.stringify(bResult));
check("turn completed", types(b).includes("turn.done"));

/* ── 4. gated tool, denied ──────────────────────────────────────── */
console.log("\ngated tool — answering “deny”");
const c = await turn("write another note", { conversationId: convId, decide: "deny" });
const cResult = c.find((e) => e.type === "tool.result")?.result;
check("tool refused", cResult?.ok === false && cResult?.denied === true, JSON.stringify(cResult));
check("turn still completed", types(c).includes("turn.done"));
check("no unhandled error", !types(c).includes("error"));

/* ── 5. MCP approval path ───────────────────────────────────────── */
console.log("\nservice-side MCP approval");
const d = await turn("use an MCP tool", { conversationId: convId, decide: "once" });
const mcpAsk = d.find((e) => e.type === "approval.required");
check("MCP approval raised", mcpAsk?.request?.origin === "mcp", mcpAsk?.request?.origin);
check("server label surfaced", !!mcpAsk?.request?.serverLabel, mcpAsk?.request?.serverLabel);
check("turn completed", types(d).includes("turn.done"));

/* ── 6. targets and model switching ─────────────────────────────── */
console.log("\ntargets");
const targets = await fetch(`${BASE}/api/targets`).then((r) => r.json());
check("targets listed", Array.isArray(targets) && targets.length > 0, JSON.stringify(targets));
check("an agent target exists", targets.some((t) => t.kind === "agent"));
check("model deployments listed", targets.some((t) => t.kind === "model"));
check("exactly one default", targets.filter((t) => t.isDefault).length === 1);
check(
  "agents use agent tools, models use harness tools",
  targets.every((t) => t.toolSource === (t.kind === "agent" ? "agent" : "harness")),
);

console.log("\nswitching model mid-conversation");
const picked = targets.find((t) => t.kind === "model");
const e = await turn("hello there", { conversationId: convId, targetId: picked.id });
const done = e.find((x) => x.type === "turn.done");
check("turn.done reports the target used", done?.targetId === picked.id, done?.targetId);
check("reply came from the chosen model", text(e).includes(picked.label), text(e).slice(0, 60));

const convAfter = await fetch(`${BASE}/api/conversations`).then((r) => r.json());
check(
  "conversation remembers its target",
  convAfter.find((c) => c.id === convId)?.targetId === picked.id,
);

// Omitting targetId must not silently fall back to the default agent.
const f = await turn("hello again", { conversationId: convId });
const doneF = f.find((x) => x.type === "turn.done");
check("omitted target keeps the pinned one", doneF?.targetId === picked.id, doneF?.targetId);

const agentTarget = targets.find((t) => t.kind === "agent");
const g = await turn("hello once more", { conversationId: convId, targetId: agentTarget.id });
check(
  "switching back to the agent works",
  g.find((x) => x.type === "turn.done")?.targetId === agentTarget.id,
);

/* ── 7. persistence ─────────────────────────────────────────────── */
console.log("\npersistence");
const convs = await fetch(`${BASE}/api/conversations`).then((r) => r.json());
check("conversation listed", convs.some((x) => x.id === convId));
const turns = await fetch(`${BASE}/api/conversations/${convId}/turns`).then((r) => r.json());
check("transcript stored", turns.length >= 4, `${turns.length} turns`);
check("turns record which target answered", turns.some((t) => !!t.targetId));
check(
  "title derived from first message",
  convs.find((x) => x.id === convId)?.title?.length > 0,
);

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 1 && 0 : 1);
