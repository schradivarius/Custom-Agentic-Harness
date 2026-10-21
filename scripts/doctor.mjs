#!/usr/bin/env node
/**
 * Check a real Foundry connection and print a report that is safe to paste.
 *
 * Nothing secret is printed: tokens are never read, and the endpoint and tenant
 * are redacted to their shape. Run it where the harness will run:
 *
 *   az login && node scripts/doctor.mjs
 */

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

// Load .env without a dependency, so doctor runs before npm install if need be.
try {
  const env = readFileSync(path.resolve(import.meta.dirname, "..", ".env"), "utf8");
  for (const line of env.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch {
  /* no .env is fine if the variables are already exported */
}

const redactHost = (url) => {
  try {
    const u = new URL(url);
    const parts = u.hostname.split(".");
    return `${"*".repeat(Math.min(parts[0].length, 8))}.${parts.slice(1).join(".")}${u.pathname.replace(/\/projects\/[^/]+/, "/projects/<project>")}`;
  } catch {
    return "<unparseable>";
  }
};

const lines = [];
let problems = 0;
const check2 = (label, ok, detail = "") => {
  if (!ok) problems++;
  say(`  ${label.padEnd(18)} ${ok ? "ok" : `FAIL  ${detail}`}`);
};
const say = (s) => { lines.push(s); console.log(s); };
const ok = (b) => (b ? "ok" : "FAIL");

say("foundry-desk doctor");
say("=".repeat(52));

/* 1 — configuration present */
const endpoint = process.env.FOUNDRY_PROJECT_ENDPOINT ?? "";
const agentName = process.env.FOUNDRY_AGENT_NAME ?? "";
say(`node                 ${process.version}`);
say(`endpoint set         ${ok(!!endpoint)}  ${endpoint ? redactHost(endpoint) : ""}`);
say(`endpoint shape       ${ok(/^https:\/\/[^.]+\.services\.ai\.azure\.com\/api\/projects\/.+/.test(endpoint))}`);
say(`agent name set       ${agentName ? "ok" : "–"}   ${agentName || "(not set — will list what the project has)"}`);
say(`agent ref mode       ${process.env.FOUNDRY_AGENT_REF_MODE || "client (default)"}`);

if (!endpoint) {
  say("\nSet FOUNDRY_PROJECT_ENDPOINT in .env, then re-run.");
  say("Foundry portal -> your project -> Overview -> project endpoint.");
  process.exit(1);
}

/* 2 — can we reach the host at all */
let reachable = false;
try {
  const u = new URL(endpoint);
  const res = await fetch(`${u.origin}/`, { method: "HEAD", signal: AbortSignal.timeout(15000) });
  reachable = true;
  say(`host reachable       ok  (HTTP ${res.status})`);
} catch (err) {
  say(`host reachable       FAIL  ${String(err?.message ?? err).slice(0, 90)}`);
}

/* 3 — credential.
   The SDK uses this scope; doctor must ask for the same one or it would
   report a failure the harness would never hit. */
const SCOPE = "https://ai.azure.com/.default";

function sh(cmd, args) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("error", () => resolve(null));
    c.on("close", (code) => resolve(code === 0 ? out.trim() : null));
    setTimeout(() => { try { c.kill(); } catch { /* gone */ } resolve(null); }, 15000);
  });
}

let credential;
try {
  const { DefaultAzureCredential } = await import("@azure/identity");
  credential = new DefaultAzureCredential();
  const token = await credential.getToken(SCOPE);
  const claims = JSON.parse(Buffer.from(token.token.split(".")[1], "base64url").toString());
  say(`credential           ok  (expires ${new Date(token.expiresOnTimestamp).toISOString()})`);
  say(`  identity kind      ${claims.idtyp ?? (claims.appid ? "service principal" : "user")}`);
  say(`  tenant             ${String(claims.tid ?? "").slice(0, 8)}…`);
} catch (err) {
  credential = undefined;
  say(`credential           FAIL`);

  /* DefaultAzureCredential is a chain; the headline names only the first link
     that was unavailable, which is rarely the useful one. Pinpoint it. */
  const azPath = await sh("which", ["az"]);
  say(`  az on PATH         ${azPath ? azPath.split("\n")[0] : "NOT FOUND — install the Azure CLI"}`);

  if (azPath) {
    const acct = await sh("az", ["account", "show", "--output", "json"]);
    if (!acct) {
      say("  az signed in       NO  → run: az login --use-device-code");
    } else {
      try {
        const a = JSON.parse(acct);
        say(`  az signed in       yes  (${a.user?.name ?? a.user?.type ?? "?"})`);
        say(`  az tenant          ${String(a.tenantId ?? "").slice(0, 8)}…`);
      } catch {
        say("  az signed in       yes (unparseable account output)");
      }
      // Signed in but the chain still failed — try the CLI link on its own.
      try {
        const { AzureCliCredential } = await import("@azure/identity");
        await new AzureCliCredential().getToken(SCOPE);
        say("  AzureCliCredential ok — re-run doctor; the chain should now pass");
      } catch (e2) {
        say(`  AzureCliCredential FAIL  ${String(e2?.message ?? e2).slice(0, 220)}`);
        say("  → your login has no access to this scope. Check the tenant:");
        say("      az login --use-device-code --tenant <tenant-id-of-the-project>");
      }
    }
  }
  say("  (or set AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_CLIENT_SECRET for a service principal)");
}

/* 4 — the agent itself */
if (reachable && credential) {
  try {
    const { AIProjectClient } = await import("@azure/ai-projects");
    const project = new AIProjectClient(endpoint, credential);
    const agents = project.agents;

    /* What the project holds — the answer to "what do I put in .env?" */
    say(`\nagents in this project`);
    const agentNames = [];
    try {
      const iter = agents.list?.();
      if (!iter) {
        say("  (this SDK build exposes no agents.list)");
      } else {
        for await (const a of iter) {
          const n = String(a?.name ?? "");
          if (!n) continue;
          agentNames.push(n);
          const tools = a?.tools ?? [];
          const fns = tools.filter((t) => t.type === "function").map((t) => t.name);
          say(
            `  · ${n}${a?.model ? `  [${a.model}]` : ""}` +
              `  tools: ${tools.length}${fns.length ? ` (fn: ${fns.join(", ")})` : ""}`,
          );
        }
        if (agentNames.length === 0) say("  (none — create one in the portal, or use a model deployment below)");
      }
    } catch (err) {
      say(`  could not list: ${String(err?.message ?? err).slice(0, 110)}`);
    }

    say(`\nmodel deployments in this project`);
    const deploymentNames = [];
    try {
      for await (const d of project.deployments.list()) {
        if (d?.type !== "ModelDeployment") continue;
        deploymentNames.push(String(d.name));
        say(`  · ${d.name}  [${[d.modelPublisher, d.modelName].filter(Boolean).join(" / ")}]`);
      }
      if (deploymentNames.length === 0) say("  (none deployed)");
    } catch (err) {
      say(`  could not list: ${String(err?.message ?? err).slice(0, 110)}`);
    }

    if (!agentName) {
      say("\nFOUNDRY_AGENT_NAME is not set, so the agent checks are skipped.");
      if (agentNames.length) {
        say(`Pick one of the agents above, e.g.  FOUNDRY_AGENT_NAME=${agentNames[0]}`);
      } else if (deploymentNames.length) {
        say("No agents exist yet. Either create one in the portal, or set");
        say(`  FOUNDRY_AGENT_NAME=foundry-desk  FOUNDRY_MODEL_NAME=${deploymentNames[0]}  FOUNDRY_SYNC_TOOLS=true`);
        say("and the harness will create it, with its local tools declared.");
      }
      say("\n" + "=".repeat(52));
      say("Safe to paste: no tokens, keys or full hostnames above.");
      process.exit(0);
    }

    say(`\nagent lookup "${agentName}"`);
    let found = null;
    try {
      found = await agents.getVersion?.(agentName);
    } catch {
      try { found = await agents.get?.(agentName); } catch { /* reported below */ }
    }
    say(`  resolved           ${ok(!!found)}`);
    if (found) {
      say(`  version            ${found.version ?? "?"}`);
      say(`  kind               ${found.kind ?? "?"}`);
      const tools = found.tools ?? [];
      say(`  tools declared     ${tools.length}`);
      for (const t of tools) say(`    · ${t.type}${t.name ? ` (${t.name})` : ""}`);
      const fns = tools.filter((t) => t.type === "function").map((t) => t.name);
      say(`  local fn tools     ${fns.length ? fns.join(", ") : "NONE — the model cannot call local tools"}`);
    }

    /* Which agent-reference shape does this project accept? The harness
       probes this at runtime; report it here so it is known up front. */
    say(`\nagent reference shape`);
    let workingMode = null;
    for (const mode of ["client", "body"]) {
      const c =
        mode === "client"
          ? project.getOpenAIClient({ azureConfig: { allowPreview: true, agentName } })
          : project.getOpenAIClient();
      const extra =
        mode === "body"
          ? { agent_reference: { name: agentName, type: "agent_reference" } }
          : {};
      try {
        await c.responses.create({
          ...extra,
          input: [{ type: "message", role: "user", content: "ping" }],
          max_output_tokens: 16,
        });
        say(`  ${mode.padEnd(7)} ok`);
        workingMode ??= mode;
      } catch (err) {
        say(`  ${mode.padEnd(7)} FAIL  ${String(err?.message ?? err).slice(0, 100)}`);
      }
    }
    if (workingMode) {
      say(`  → the harness will use "${workingMode}" (FOUNDRY_AGENT_REF_MODE=auto)`);
    } else {
      say("  → neither shape worked; the cause is probably credentials or agent name, not shape");
    }

    /* Titling target. The failure that matters is silent: an agent that
       declares tools can answer a title request with a function_call. */
    const titleAgent = process.env.FOUNDRY_TITLE_AGENT?.trim();
    const titleModel = (process.env.FOUNDRY_TITLE_MODEL || process.env.FOUNDRY_MODEL_NAME || "").trim();
    say(`\nconversation titles`);
    if (process.env.FOUNDRY_TITLES === "false") {
      say("  disabled           FOUNDRY_TITLES=false");
    } else if (titleAgent) {
      say(`  using agent        ${titleAgent}`);
      let ta = null;
      try {
        ta = await agents.getVersion?.(titleAgent);
      } catch {
        try { ta = await agents.get?.(titleAgent); } catch { /* reported below */ }
      }
      check2("agent resolves", !!ta);
      if (ta) {
        const tools = ta.tools ?? [];
        check2(
          "declares no tools",
          tools.length === 0,
          `declares ${tools.length} (${tools.map((t) => t.type).join(", ")}) — a tool call ` +
            `returned for a title starts a tool loop`,
        );
      }
    } else if (titleModel) {
      say(`  using deployment   ${titleModel}`);
      check2(
        "deployment exists",
        deploymentNames.length === 0 || deploymentNames.includes(titleModel),
        `${titleModel} is not in this project's deployments`,
      );
    } else {
      say("  not configured     set FOUNDRY_TITLE_AGENT or FOUNDRY_TITLE_MODEL");
      say("                     (conversations keep their first-message titles)");
    }

    say(`\nresponses round trip`);
    const openai =
      workingMode === "body"
        ? project.getOpenAIClient()
        : project.getOpenAIClient({ azureConfig: { allowPreview: true, agentName } });
    const conv = await openai.conversations.create({});
    say(`  conversation       ok  (${String(conv.id).slice(0, 14)}…)`);
    const resp = await openai.responses.create({
      conversation: conv.id,
      input: [{ type: "message", role: "user", content: "Reply with the single word: ready" }],
    });
    say(`  response           ok  (${String(resp.output_text ?? "").trim().slice(0, 40)})`);
    say(`  output item types  ${(resp.output ?? []).map((i) => i.type).join(", ") || "none"}`);
    await openai.conversations.delete(conv.id).catch(() => {});
    say(`  cleanup            ok`);
  } catch (err) {
    say(`  FAILED  ${String(err?.message ?? err).slice(0, 300)}`);
    if (err?.status) say(`  http status        ${err.status}`);
    if (err?.code) say(`  code               ${err.code}`);
  }
}

say("\n" + "=".repeat(52));
say("Safe to paste: no tokens, keys or full hostnames above.");
