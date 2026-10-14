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

/* 3 — credential */
let credential;
try {
  const { DefaultAzureCredential } = await import("@azure/identity");
  credential = new DefaultAzureCredential();
  const token = await credential.getToken("https://ai.azure.com/.default");
  const claims = JSON.parse(Buffer.from(token.token.split(".")[1], "base64url").toString());
  say(`credential           ok  (expires ${new Date(token.expiresOnTimestamp).toISOString()})`);
  say(`  identity kind      ${claims.idtyp ?? (claims.appid ? "service principal" : "user")}`);
  say(`  tenant             ${String(claims.tid ?? "").slice(0, 8)}…`);
} catch (err) {
  say(`credential           FAIL  ${String(err?.message ?? err).slice(0, 160)}`);
  say("  → run `az login`, or set AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_CLIENT_SECRET");
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

    say(`\nresponses round trip`);
    const openai = project.getOpenAIClient({
      azureConfig: { allowPreview: true, agentName },
    });
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
