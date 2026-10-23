/**
 * The wire protocol between the harness and the UI.
 *
 * Foundry's agent runtime speaks an extended OpenAI Responses protocol. The UI
 * deliberately does not: it sees this normalized event stream instead, so that
 * a change on the Foundry side (or swapping in a different agent host) is a
 * server-side concern only.
 */

export type RiskTier = "safe" | "caution" | "dangerous";

/** Where a tool call is actually executed. */
export type ToolOrigin =
  /** A `function` tool the model asked for; this harness runs it locally. */
  | "local"
  /** An MCP tool invoked by Foundry; the service runs it, we only approve it. */
  | "mcp"
  /** A Foundry built-in (code interpreter, file search, OpenAPI, …). */
  | "foundry";

export interface ToolCallView {
  id: string;
  name: string;
  origin: ToolOrigin;
  /** Already-parsed arguments when they were valid JSON, else the raw string. */
  args: unknown;
  serverLabel?: string;
}

export interface ToolResultView {
  id: string;
  name: string;
  ok: boolean;
  /** Rendered output, truncated for display. */
  output: string;
  durationMs: number;
  /** Set when the call was refused rather than attempted. */
  denied?: boolean;
}

export interface ApprovalRequestView {
  approvalId: string;
  toolCallId: string;
  name: string;
  origin: ToolOrigin;
  risk: RiskTier;
  args: unknown;
  serverLabel?: string;
  /** One-line human summary, e.g. `write_file → notes/todo.md (412 bytes)`. */
  preview: string;
  expiresAt: number;
}

export type ApprovalDecision = "once" | "session" | "deny";

/* ───────────────────────────── artifacts ───────────────────────────── */

/**
 * What an artifact holds, which decides how the panel renders it.
 *
 * `document` is the odd one out: its payload is a binary office file the
 * server generated, so it is downloadable but not editable in place. The rest
 * are text the agent wrote and can rewrite.
 */
export type ArtifactKind = "markdown" | "code" | "html" | "svg" | "document";

export interface ArtifactVersion {
  version: number;
  at: number;
  /** Text artifacts only. A `document` keeps its bytes on disk instead. */
  text?: string;
  /** Bytes on disk, relative to the artifact store. `document` only. */
  file?: string;
  bytes: number;
}

export interface ArtifactMeta {
  id: string;
  conversationId: string;
  title: string;
  kind: ArtifactKind;
  /** Source language for `code`, e.g. `python`. */
  language?: string;
  /** Suggested download name, extension included. */
  filename: string;
  mime: string;
  createdAt: number;
  updatedAt: number;
  /** Highest version number; versions are 1-based and never renumbered. */
  version: number;
}

/** An artifact plus the content of one version — what the panel renders. */
export interface ArtifactView extends ArtifactMeta {
  /** Absent for `document`, whose content is only ever downloaded. */
  text?: string;
  /** Every version, oldest first, for the version switcher. */
  history: { version: number; at: number; bytes: number }[];
}

/** Server → UI. Discriminated on `type`. */
export type HarnessEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "conversation.titled"; conversationId: string; title: string }
  | { type: "response.started"; responseId: string }
  | { type: "text.delta"; delta: string }
  | { type: "text.done"; text: string }
  | { type: "reasoning.delta"; delta: string }
  | { type: "tool.call"; call: ToolCallView }
  | { type: "approval.required"; request: ApprovalRequestView }
  | { type: "approval.resolved"; approvalId: string; decision: ApprovalDecision }
  | { type: "tool.result"; result: ToolResultView }
  | { type: "artifact.created"; artifact: ArtifactView }
  | { type: "artifact.updated"; artifact: ArtifactView }
  | { type: "turn.done"; responseId: string; usage?: TokenUsage; targetId?: string }
  | { type: "error"; message: string; retryable: boolean };

export interface TokenUsage {
  input?: number;
  output?: number;
  total?: number;
}

/** Persisted conversation metadata. The transcript itself lives in Foundry. */
export interface ConversationMeta {
  /** Foundry conversation id (`conv_…`). */
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Last response id, used to chain tool outputs onto the right turn. */
  lastResponseId?: string;
  messageCount: number;
  /** Which agent or model deployment this conversation is addressed to. */
  targetId?: string;
  /** True while the title is still machine-assigned and may be replaced. */
  titleAuto?: boolean;
}

/** A transcript turn, mirrored locally so the sidebar can rehydrate instantly. */
export interface StoredTurn {
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  toolCalls?: ToolCallView[];
  toolResults?: ToolResultView[];
  /** Which agent or model produced this turn. */
  targetId?: string;
}
