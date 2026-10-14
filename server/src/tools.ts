import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import type { RiskTier } from "./protocol.js";

const execFileAsync = promisify(execFile);

export interface ToolDef {
  name: string;
  description: string;
  risk: RiskTier;
  /** JSON Schema for the arguments, as sent to Foundry in the agent version. */
  parameters: Record<string, unknown>;
  /** One-line human summary shown in the approval prompt. */
  preview: (args: any) => string;
  run: (args: any) => Promise<string>;
}

/* ───────────────────────── path containment ───────────────────────── */

/**
 * Resolve a caller-supplied path inside the workspace root, refusing anything
 * that escapes it.
 *
 * The containment check runs against the *real* location of the path — every
 * symlink on the way resolved — because a link planted inside the workspace is
 * otherwise a way straight out of it. For a path that does not exist yet, the
 * nearest existing ancestor is resolved and the remaining components appended,
 * so `write_file` is held to the same boundary as `read_file`.
 *
 * Caveat worth knowing: this is a check-then-use, so a symlink swapped in
 * between the check and the open would defeat it. Closing that properly needs
 * openat2/O_NOFOLLOW, which Node does not expose. For a single-user desktop
 * harness the gap is acceptable; it would not be in a multi-tenant service.
 */
async function resolveInWorkspace(input: unknown): Promise<string> {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("`path` must be a non-empty string.");
  }
  if (path.isAbsolute(input)) {
    throw new Error("`path` must be relative to the workspace root.");
  }
  const root = await fs.realpath(config.workspaceRoot);
  const target = path.resolve(root, input);

  // Walk up to the nearest entry that exists. lstat, not stat, so a dangling
  // symlink counts as existing rather than being skipped over as missing.
  const missing: string[] = [];
  let existing = target;
  for (;;) {
    try {
      await fs.lstat(existing);
      break;
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error("Could not resolve path.");
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }

  let realExisting: string;
  try {
    realExisting = await fs.realpath(existing);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      // A symlink whose destination does not exist: there is no way to prove
      // where a write through it would land, so refuse instead of guessing.
      throw new Error(`Refusing to follow a broken symlink: ${input}`);
    }
    throw err;
  }

  const realTarget = missing.length ? path.join(realExisting, ...missing) : realExisting;

  // An empty relative path means the root itself, which is in bounds — listing
  // the workspace root is the most ordinary thing a tool can be asked to do.
  const rel = path.relative(root, realTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refusing to touch a path outside the workspace root: ${input}`);
  }
  return realTarget;
}

function clip(text: string, max = 20_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} more characters]`;
}

/* ───────────────────────────── the tools ──────────────────────────── */

const readFile: ToolDef = {
  name: "read_file",
  description:
    "Read a UTF-8 text file from the user's workspace. The path must be relative to the workspace root.",
  risk: "safe",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  preview: (a) => `read ${a?.path}`,
  run: async (a) => {
    const p = await resolveInWorkspace(a?.path);
    return clip(await fs.readFile(p, "utf8"));
  },
};

const listDirectory: ToolDef = {
  name: "list_directory",
  description:
    "List the entries of a directory in the user's workspace. Use \".\" for the workspace root.",
  risk: "safe",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path relative to the workspace root." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  preview: (a) => `list ${a?.path}`,
  run: async (a) => {
    const p = await resolveInWorkspace(a?.path === "." ? "./" : a?.path);
    const entries = await fs.readdir(p, { withFileTypes: true });
    if (entries.length === 0) return "(empty directory)";
    return entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join("\n");
  },
};

const writeFile: ToolDef = {
  name: "write_file",
  description:
    "Create or overwrite a UTF-8 text file in the user's workspace. Overwrites without warning, so read first if you need the previous contents.",
  risk: "caution",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root." },
      content: { type: "string", description: "Full file contents to write." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  preview: (a) =>
    `write ${a?.path} (${Buffer.byteLength(String(a?.content ?? ""), "utf8")} bytes)`,
  run: async (a) => {
    if (typeof a?.content !== "string") throw new Error("`content` must be a string.");
    const p = await resolveInWorkspace(a?.path);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, a.content, "utf8");
    return `Wrote ${Buffer.byteLength(a.content, "utf8")} bytes to ${a.path}`;
  },
};

const fetchUrl: ToolDef = {
  name: "fetch_url",
  description: "Fetch an https URL and return the response body as text (truncated).",
  risk: "caution",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "An https:// URL." } },
    required: ["url"],
    additionalProperties: false,
  },
  preview: (a) => `fetch ${a?.url}`,
  run: async (a) => {
    let parsed: URL;
    try {
      parsed = new URL(String(a?.url));
    } catch {
      throw new Error("`url` is not a valid URL.");
    }
    if (parsed.protocol !== "https:") throw new Error("Only https:// URLs are allowed.");
    const res = await fetch(parsed, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
      headers: { accept: "text/*, application/json;q=0.9, */*;q=0.1" },
    });
    const body = await res.text();
    return clip(`HTTP ${res.status} ${res.statusText}\n\n${body}`);
  },
};

const runCommand: ToolDef = {
  name: "run_command",
  description:
    "Run an allowlisted command in the user's workspace and return its combined output.",
  risk: "dangerous",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Executable name, with no shell syntax." },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Arguments passed to the command.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  preview: (a) => `run ${a?.command} ${(a?.args ?? []).join(" ")}`.trim(),
  run: async (a) => {
    const command = String(a?.command ?? "");
    if (!config.shell.allowlist.includes(command)) {
      throw new Error(
        `"${command}" is not in SHELL_ALLOWLIST (${config.shell.allowlist.join(", ")}).`,
      );
    }
    const args = Array.isArray(a?.args) ? a.args.map(String) : [];
    try {
      // execFile, not exec: no shell, so no quoting or injection surface.
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: config.workspaceRoot,
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return clip([stdout, stderr].filter(Boolean).join("\n").trim() || "(no output)");
    } catch (err: any) {
      const out = [err?.stdout, err?.stderr].filter(Boolean).join("\n").trim();
      throw new Error(clip(`exit ${err?.code ?? "?"}: ${out || err?.message}`, 4_000));
    }
  },
};

/* ──────────────────────────── the registry ────────────────────────── */

const all: ToolDef[] = [readFile, listDirectory, writeFile, fetchUrl];
if (config.shell.enabled) all.push(runCommand);

export const registry = new Map<string, ToolDef>(all.map((t) => [t.name, t]));

export function listTools(): ToolDef[] {
  return [...registry.values()];
}

/**
 * The local tools in the shape Foundry wants when creating an agent version.
 * Flat `name`/`parameters` on the tool object, per the ai-projects samples.
 */
export function toolSchemasForFoundry(): Record<string, unknown>[] {
  return listTools().map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: false,
  }));
}
