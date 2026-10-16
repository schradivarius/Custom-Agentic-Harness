#!/usr/bin/env node
/**
 * Verify the agent-reference auto-probe.
 *
 * Azure's own samples disagree on how an agent reference travels, so the
 * harness probes both shapes on first use. A live Foundry project is the only
 * place that can settle it for real — this exercises the decision logic
 * against a mock project rigged to accept exactly one shape, which is the part
 * that can actually be wrong in code.
 *
 * Run `npm run build --workspace server` first.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "server");
let failures = 0;

function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
}

/** Boot the server with a rigged mock, send one turn, return its stdout. */
function run(env, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/index.js"], {
      cwd: serverDir,
      env: { ...process.env, FOUNDRY_MOCK: "true", PORT: String(port), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));

    const done = (v) => {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      resolve(v);
    };

    const poll = setInterval(async () => {
      try {
        const r = await fetch(`http://localhost:${port}/api/health`);
        if (!r.ok) return;
        clearInterval(poll);
        // One turn, which triggers the probe.
        const chat = await fetch(`http://localhost:${port}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "hello", sessionId: "probe" }),
        });
        const body = await chat.text();
        const health = await (await fetch(`http://localhost:${port}/api/health`)).json();
        setTimeout(() => done({ out, body, health }), 150);
      } catch { /* not up yet */ }
    }, 250);

    setTimeout(() => { clearInterval(poll); done({ out, body: "", health: {} }); }, 25000);
  });
}

console.log("\nagent-reference auto-probe\n");

for (const want of ["client", "body"]) {
  const port = want === "client" ? 4471 : 4472;
  console.log(`project accepts only "${want}"`);
  const { out, body, health } = await run({ FOUNDRY_MOCK_REF_MODE: want }, port);

  check("probe resolved to the accepted shape", out.includes(`resolved to "${want}"`), out.slice(-240));
  check("health reports it", String(health.agentRefMode ?? "").includes(want), health.agentRefMode);
  check("the turn still completed", body.includes('"type":"turn.done"'), body.slice(-160));
  check("no error surfaced to the user", !body.includes('"type":"error"'));
  console.log("");
}

console.log('explicitly pinned mode skips the probe');
{
  const { out } = await run({ FOUNDRY_MOCK_REF_MODE: "body", FOUNDRY_AGENT_REF_MODE: "body" }, 4473);
  check("no probe ran", !out.includes("resolved to"), out.slice(-160));
}

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
