import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import type { ArtifactKind, ArtifactMeta, ArtifactVersion, ArtifactView } from "./protocol.js";

/**
 * Store for agent-produced artifacts: the documents, code files and pages a
 * turn generates, kept apart from the chat transcript so they survive it and
 * can be re-opened, re-downloaded and superseded.
 *
 * Two storage shapes on purpose. Text artifacts live inline in the index,
 * which keeps a reload to one file read. A `document` is a generated office
 * file of unbounded size, so its bytes go to their own file on disk and only
 * the pointer is indexed — otherwise a handful of reports would turn the index
 * into megabytes of base64 that has to be parsed on every startup.
 */

interface Record_ extends ArtifactMeta {
  versions: ArtifactVersion[];
}

interface Db {
  artifacts: Record_[];
}

const dir = path.join(config.dataDir, "artifacts");
const dbPath = path.join(dir, "index.json");

function load(): Db {
  try {
    const parsed = JSON.parse(fs.readFileSync(dbPath, "utf8")) as Partial<Db>;
    return { artifacts: parsed.artifacts ?? [] };
  } catch {
    return { artifacts: [] };
  }
}

let db = load();

/**
 * Persist the index now, not on a timer.
 *
 * The conversation store debounces its writes because turns arrive token by
 * token and the data is reconstructible from Foundry anyway. Neither holds
 * here: an artifact is written a few times per conversation, and it is the
 * deliverable — there is no upstream copy to re-fetch. A debounced write loses
 * the index entry if the process stops in that window, which for a `document`
 * also orphans the bytes already on disk. Writing through costs a few
 * milliseconds at a rate nobody will notice.
 */
function save(): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${dbPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
    fs.renameSync(tmp, dbPath);
  } catch (err) {
    console.error("[artifacts] failed to persist:", err);
  }
}

/* ───────────────────────────── naming ───────────────────────────── */

const EXT: Record<Exclude<ArtifactKind, "code" | "document">, string> = {
  markdown: "md",
  html: "html",
  svg: "svg",
};

const MIME: Record<Exclude<ArtifactKind, "code" | "document">, string> = {
  markdown: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
  svg: "image/svg+xml",
};

/** Extensions for the languages an agent is likely to emit as a `code` artifact. */
const LANG_EXT: Record<string, string> = {
  bash: "sh",
  c: "c",
  cpp: "cpp",
  csharp: "cs",
  css: "css",
  go: "go",
  java: "java",
  javascript: "js",
  json: "json",
  jsx: "jsx",
  kotlin: "kt",
  powershell: "ps1",
  python: "py",
  r: "r",
  ruby: "rb",
  rust: "rs",
  shell: "sh",
  sh: "sh",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  ts: "ts",
  tsx: "tsx",
  typescript: "ts",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

/**
 * Turn a title into a filename safe on every platform.
 *
 * This feeds `Content-Disposition`, so it is a security boundary and not only
 * a tidiness measure: a title is agent-authored text, and a stray quote, CR or
 * path separator in that header is a response-splitting or path-escape
 * primitive. Only an allowlist of characters survives.
 */
export function safeFilename(title: string, ext: string): string {
  const stem =
    title
      .normalize("NFKD")
      .replace(/[^\w\s.-]/g, "")
      .replace(/[\s_]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 60)
      .toLowerCase() || "artifact";
  return `${stem}.${ext}`;
}

/* ───────────────────────────── API ───────────────────────────── */

function toView(r: Record_, version?: number): ArtifactView {
  const want = version ?? r.version;
  const v = r.versions.find((x) => x.version === want) ?? r.versions[r.versions.length - 1];
  const { versions, ...meta } = r;
  return {
    ...meta,
    version: v?.version ?? r.version,
    ...(v?.text !== undefined ? { text: v.text } : {}),
    history: versions.map((x) => ({ version: x.version, at: x.at, bytes: x.bytes })),
  };
}

export const artifacts = {
  /** Create a text artifact. Returns the view the UI renders. */
  createText(input: {
    conversationId: string;
    title: string;
    kind: Exclude<ArtifactKind, "document">;
    text: string;
    language?: string;
  }): ArtifactView {
    const now = Date.now();
    const ext =
      input.kind === "code"
        ? (LANG_EXT[(input.language ?? "").toLowerCase()] ?? "txt")
        : EXT[input.kind];
    const mime =
      input.kind === "code" ? "text/plain; charset=utf-8" : MIME[input.kind];

    const rec: Record_ = {
      id: randomUUID(),
      conversationId: input.conversationId,
      title: input.title,
      kind: input.kind,
      ...(input.language ? { language: input.language } : {}),
      filename: safeFilename(input.title, ext),
      mime,
      createdAt: now,
      updatedAt: now,
      version: 1,
      versions: [
        { version: 1, at: now, text: input.text, bytes: Buffer.byteLength(input.text, "utf8") },
      ],
    };
    db.artifacts.push(rec);
    save();
    return toView(rec);
  },

  /** Create a binary document artifact from already-generated bytes. */
  createDocument(input: {
    conversationId: string;
    title: string;
    filename: string;
    mime: string;
    bytes: Buffer;
  }): ArtifactView {
    const now = Date.now();
    const id = randomUUID();
    const rel = `${id}.v1${path.extname(input.filename)}`;

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, rel), input.bytes);

    const rec: Record_ = {
      id,
      conversationId: input.conversationId,
      title: input.title,
      kind: "document",
      filename: input.filename,
      mime: input.mime,
      createdAt: now,
      updatedAt: now,
      version: 1,
      versions: [{ version: 1, at: now, file: rel, bytes: input.bytes.byteLength }],
    };
    db.artifacts.push(rec);
    save();
    return toView(rec);
  },

  /** Append a new version of a text artifact. */
  updateText(id: string, text: string): ArtifactView | undefined {
    const r = db.artifacts.find((a) => a.id === id);
    if (!r || r.kind === "document") return undefined;
    const now = Date.now();
    r.version += 1;
    r.updatedAt = now;
    r.versions.push({
      version: r.version,
      at: now,
      text,
      bytes: Buffer.byteLength(text, "utf8"),
    });
    save();
    return toView(r);
  },

  get(id: string, version?: number): ArtifactView | undefined {
    const r = db.artifacts.find((a) => a.id === id);
    return r ? toView(r, version) : undefined;
  },

  /** Metadata only, for the inline cards in a rehydrated transcript. */
  listForConversation(conversationId: string): ArtifactView[] {
    return db.artifacts
      .filter((a) => a.conversationId === conversationId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((a) => toView(a));
  },

  /**
   * Bytes for a download, with the filename to serve them under.
   *
   * The path is reconstructed from the indexed basename rather than used as
   * stored, so a tampered index cannot point the read outside the store.
   */
  bytesFor(
    id: string,
    version?: number,
  ): { bytes: Buffer; filename: string; mime: string } | undefined {
    const r = db.artifacts.find((a) => a.id === id);
    if (!r) return undefined;
    const v = r.versions.find((x) => x.version === (version ?? r.version));
    if (!v) return undefined;

    if (v.text !== undefined) {
      return { bytes: Buffer.from(v.text, "utf8"), filename: r.filename, mime: r.mime };
    }
    if (!v.file) return undefined;
    try {
      const bytes = fs.readFileSync(path.join(dir, path.basename(v.file)));
      return { bytes, filename: r.filename, mime: r.mime };
    } catch {
      return undefined;
    }
  },

  /** Drop everything a deleted conversation owned, bytes included. */
  deleteForConversation(conversationId: string): void {
    const doomed = db.artifacts.filter((a) => a.conversationId === conversationId);
    for (const a of doomed) {
      for (const v of a.versions) {
        if (!v.file) continue;
        try {
          fs.unlinkSync(path.join(dir, path.basename(v.file)));
        } catch {
          // Already gone, or never written: nothing to clean up.
        }
      }
    }
    db.artifacts = db.artifacts.filter((a) => a.conversationId !== conversationId);
    save();
  },

  /** Test seam. */
  reload(): void {
    db = load();
  },
};
