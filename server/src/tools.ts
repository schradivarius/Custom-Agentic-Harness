import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import { artifacts, safeFilename } from "./artifacts.js";
import { markdownToDocx } from "./docx.js";
import type { ArtifactView, HarnessEvent, RiskTier } from "./protocol.js";

const execFileAsync = promisify(execFile);

/**
 * What a tool knows about the turn it is running in.
 *
 * Most tools need none of this. The artifact tools do: an artifact belongs to
 * a conversation, and the panel has to learn about it mid-turn rather than
 * when the turn finally ends.
 */
export interface ToolContext {
  conversationId: string;
  emit: (event: HarnessEvent) => void;
}

export interface ToolDef {
  name: string;
  description: string;
  risk: RiskTier;
  /** JSON Schema for the arguments, as sent to Foundry in the agent version. */
  parameters: Record<string, unknown>;
  /** One-line human summary shown in the approval prompt. */
  preview: (args: any) => string;
  run: (args: any, ctx: ToolContext) => Promise<string>;
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

/* ──────────────────────────── artifacts ───────────────────────────── */

/**
 * Why these are `safe` and need no approval.
 *
 * An artifact is inert by construction: it is written to the harness's own
 * store, never to the workspace, never to the network, and nothing executes
 * it. An `html` artifact is rendered in a sandboxed iframe with no
 * same-origin privilege, so it cannot reach the API or read a cookie either.
 * Gating them would mean a prompt for every paragraph of a report the user
 * just asked for, which trains people to click through prompts — the opposite
 * of what the approval gate is for.
 */

const KINDS = ["markdown", "code", "html", "svg"] as const;

/** Guard against an unbounded artifact filling the data directory. */
const MAX_ARTIFACT_BYTES = 1_000_000;

function checkSize(content: unknown): string {
  if (typeof content !== "string") throw new Error("`content` must be a string.");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_ARTIFACT_BYTES) {
    throw new Error(
      `Content is ${bytes} bytes; the limit is ${MAX_ARTIFACT_BYTES}. Split it across artifacts.`,
    );
  }
  return content;
}

const describe = (a: ArtifactView): string =>
  `Created artifact ${a.id} ("${a.title}", ${a.kind}). It is now open in the user's side panel and downloadable as ${a.filename}. Do not repeat its contents in your reply — say what it is and what you would change next.`;

const createArtifact: ToolDef = {
  name: "create_artifact",
  description:
    "Publish a standalone document, code file, page or diagram to the user's side panel, where it is rendered, versioned and downloadable. Use this instead of a long fenced code block whenever the output is a deliverable the user will keep, re-read or send on — a report, a script, a spec, a letter. Returns an artifact id; pass it to update_artifact to revise rather than creating a second artifact.",
  risk: "safe",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short human title, e.g. 'Culvert Sizing Memo'." },
      kind: {
        type: "string",
        enum: [...KINDS],
        description:
          "markdown for prose, code for a source file, html for a self-contained page, svg for a diagram.",
      },
      content: { type: "string", description: "The full content. Not a diff or an excerpt." },
      language: {
        type: "string",
        description: "For kind=code, the language, e.g. 'python'. Sets the file extension.",
      },
    },
    required: ["title", "kind", "content"],
    additionalProperties: false,
  },
  preview: (a) => `artifact "${a?.title}" (${a?.kind})`,
  run: async (a, ctx) => {
    const kind = String(a?.kind ?? "");
    if (!(KINDS as readonly string[]).includes(kind)) {
      throw new Error(`\`kind\` must be one of ${KINDS.join(", ")}.`);
    }
    const title = String(a?.title ?? "").trim();
    if (!title) throw new Error("`title` must be a non-empty string.");

    const view = artifacts.createText({
      conversationId: ctx.conversationId,
      title,
      kind: kind as (typeof KINDS)[number],
      text: checkSize(a?.content),
      ...(typeof a?.language === "string" && a.language ? { language: a.language } : {}),
    });
    ctx.emit({ type: "artifact.created", artifact: view });
    return describe(view);
  },
};

const updateArtifact: ToolDef = {
  name: "update_artifact",
  description:
    "Replace the contents of an existing artifact with a new version. The previous version is kept and the user can switch back to it. Use this for every revision of something you already published, so the user sees one evolving document rather than a pile of near-identical ones.",
  risk: "safe",
  parameters: {
    type: "object",
    properties: {
      artifact_id: { type: "string", description: "The id returned by create_artifact." },
      content: {
        type: "string",
        description: "The complete new content, not a diff. It replaces the previous version.",
      },
    },
    required: ["artifact_id", "content"],
    additionalProperties: false,
  },
  preview: (a) => `revise artifact ${a?.artifact_id}`,
  run: async (a, ctx) => {
    const id = String(a?.artifact_id ?? "");
    const existing = artifacts.get(id);
    if (!existing) throw new Error(`No artifact with id ${id}.`);
    if (existing.conversationId !== ctx.conversationId) {
      // Artifacts are per-conversation; crossing that line would let one chat
      // rewrite another's deliverable.
      throw new Error(`Artifact ${id} belongs to a different conversation.`);
    }
    if (existing.kind === "document") {
      throw new Error(
        "A generated document cannot be edited in place. Call create_document again to produce a new one.",
      );
    }
    const view = artifacts.updateText(id, checkSize(a?.content));
    if (!view) throw new Error(`Could not update artifact ${id}.`);
    ctx.emit({ type: "artifact.updated", artifact: view });
    return `Updated artifact ${id} to version ${view.version}. The panel is showing it.`;
  },
};

const createDocument: ToolDef = {
  name: "create_document",
  description:
    "Produce a real Microsoft Word (.docx) file in Aurora Technical Services house style and give it to the user to download. Write the body as Markdown — headings, paragraphs, bullet and numbered lists, tables, block quotes, fenced code and inline bold/italic/links are all converted. Aurora's typeface, red headings, page header and page numbering are applied for you, so do not describe formatting in the content. Use this whenever the user wants a document they can send, print or sign.",
  risk: "safe",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Document title. Becomes the heading on page one and the filename.",
      },
      content: { type: "string", description: "The document body as Markdown." },
      subtitle: {
        type: "string",
        description: "Optional line under the title, e.g. 'Draft for review · 23 Oct 2026'.",
      },
    },
    required: ["title", "content"],
    additionalProperties: false,
  },
  preview: (a) => `Word document "${a?.title}"`,
  run: async (a, ctx) => {
    const title = String(a?.title ?? "").trim();
    if (!title) throw new Error("`title` must be a non-empty string.");
    const markdown = checkSize(a?.content);

    const bytes = await markdownToDocx({
      title,
      markdown,
      ...(typeof a?.subtitle === "string" && a.subtitle ? { subtitle: a.subtitle } : {}),
    });

    const view = artifacts.createDocument({
      conversationId: ctx.conversationId,
      title,
      filename: safeFilename(title, "docx"),
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes,
    });
    ctx.emit({ type: "artifact.created", artifact: view });
    return `Wrote ${view.filename} (${bytes.byteLength} bytes) as artifact ${view.id}. A download button for it is now in the user's side panel. Do not paste the document text into your reply.`;
  },
};

/* ──────────────────────────── the registry ────────────────────────── */

const all: ToolDef[] = [
  readFile,
  listDirectory,
  writeFile,
  fetchUrl,
  createArtifact,
  updateArtifact,
  createDocument,
];
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
