#!/usr/bin/env node
/**
 * Direct test of workspace containment for the filesystem tools.
 *
 * The tools are the only part of the harness that touches the user's machine,
 * so the boundary gets tested on its own rather than only through a happy-path
 * conversation. Run `npm run build --workspace server` first.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fd-contain-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fd-outside-"));

fs.writeFileSync(path.join(root, "inside.txt"), "in bounds\n");
fs.mkdirSync(path.join(root, "notes"), { recursive: true });
fs.writeFileSync(path.join(outside, "secret.txt"), "OUT OF BOUNDS\n");
// A symlink planted inside the workspace that points out of it.
fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "escape-link"));
fs.symlinkSync(outside, path.join(root, "escape-dir"));

process.env.FOUNDRY_MOCK = "true";
process.env.WORKSPACE_ROOT = root;
process.env.DATA_DIR = path.join(root, ".data");
process.env.ENABLE_SHELL = "false";

const serverDir = path.resolve(import.meta.dirname, "..", "server");
const { registry } = await import(pathToFileURL(path.join(serverDir, "dist", "tools.js")).href);

const read = registry.get("read_file");
const list = registry.get("list_directory");
const write = registry.get("write_file");

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
}

async function refuses(label, fn) {
  try {
    const out = await fn();
    check(label, false, `allowed, returned ${JSON.stringify(String(out).slice(0, 60))}`);
  } catch (err) {
    const msg = String(err?.message ?? err);
    // Must be refused by the containment check, not merely by a missing file.
    const contained = /outside the workspace|must be relative|non-empty string/i.test(msg);
    check(label, contained, `rejected for the wrong reason: ${msg}`);
  }
}

async function allows(label, fn, expect) {
  try {
    const out = await fn();
    check(label, expect ? expect(out) : true, `got ${JSON.stringify(String(out).slice(0, 80))}`);
  } catch (err) {
    check(label, false, String(err?.message ?? err));
  }
}

console.log(`\nworkspace containment\n  root: ${root}\n`);

console.log("in bounds");
await allows("read a file in the workspace", () => read.run({ path: "inside.txt" }), (o) =>
  o.includes("in bounds"),
);
await allows("list the workspace root", () => list.run({ path: "." }), (o) =>
  o.includes("inside.txt"),
);
await allows("write into a subdirectory", () => write.run({ path: "notes/ok.md", content: "hi" }));
await allows("read back what was written", () => read.run({ path: "notes/ok.md" }), (o) =>
  o.includes("hi"),
);

console.log("\nout of bounds");
await refuses("parent traversal", () => read.run({ path: "../secret.txt" }));
await refuses("deep traversal", () => read.run({ path: "notes/../../secret.txt" }));
await refuses("absolute path", () => read.run({ path: path.join(outside, "secret.txt") }));
await refuses("absolute system path", () => read.run({ path: "/etc/passwd" }));
await refuses("symlink to a file outside", () => read.run({ path: "escape-link" }));
await refuses("symlink to a directory outside", () => read.run({ path: "escape-dir/secret.txt" }));
await refuses("write through an escaping symlink", () =>
  write.run({ path: "escape-dir/planted.txt", content: "should not land" }),
);
await refuses("write via traversal", () =>
  write.run({ path: "../planted.txt", content: "should not land" }),
);
await refuses("empty path", () => read.run({ path: "" }));
await refuses("missing path", () => read.run({}));

console.log("\nnothing was planted outside");
const strays = fs.readdirSync(outside).filter((f) => f !== "secret.txt");
check("outside directory untouched", strays.length === 0, strays.join(", "));

console.log("\ndisabled tools");
check("shell tool absent when ENABLE_SHELL=false", !registry.has("run_command"));

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
