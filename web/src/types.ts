/** Mirror of the harness protocol (server/src/protocol.ts). */

export type RiskTier = "safe" | "caution" | "dangerous";
export type ToolOrigin = "local" | "mcp" | "foundry";
export type ApprovalDecision = "once" | "session" | "deny";

export interface ToolCallView {
  id: string;
  name: string;
  origin: ToolOrigin;
  args: unknown;
  serverLabel?: string;
}

export interface ToolResultView {
  id: string;
  name: string;
  ok: boolean;
  output: string;
  durationMs: number;
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
  preview: string;
  expiresAt: number;
}

export type ArtifactKind = "markdown" | "code" | "html" | "svg" | "document";

export interface ArtifactView {
  id: string;
  conversationId: string;
  title: string;
  kind: ArtifactKind;
  language?: string;
  filename: string;
  mime: string;
  createdAt: number;
  updatedAt: number;
  version: number;
  /** Absent for `document`, which is only ever downloaded. */
  text?: string;
  history: { version: number; at: number; bytes: number }[];
}

export interface TokenUsage {
  input?: number;
  output?: number;
  total?: number;
}

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

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastResponseId?: string;
  messageCount: number;
  targetId?: string;
  titleAuto?: boolean;
}

export interface StoredTurn {
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  toolCalls?: ToolCallView[];
  toolResults?: ToolResultView[];
  targetId?: string;
}

export interface TargetOption {
  id: string;
  kind: "agent" | "model";
  label: string;
  detail?: string;
  isDefault: boolean;
  /** `agent` = the agent declares its own tools; `harness` = we send ours. */
  toolSource: "agent" | "harness";
}

export interface ToolInfo {
  name: string;
  description: string;
  risk: RiskTier;
  autoApproved: boolean;
}

export interface HealthReport {
  ok: boolean;
  endpoint: string;
  agentName: string;
  agentRefMode: string;
  localTools: string[];
  detail?: string;
  autoApprove: RiskTier[];
  shellEnabled: boolean;
  workspaceRoot: string;
}

/* ── UI-side view model ───────────────────────────────────────────── */

/** One rendered block in the transcript. */
export type Block =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "assistant";
      id: string;
      text: string;
      streaming: boolean;
      usage?: TokenUsage;
      targetId?: string;
    }
  | {
      kind: "tool";
      id: string;
      call: ToolCallView;
      result?: ToolResultView;
      approval?: ApprovalRequestView;
      decision?: ApprovalDecision;
    }
  | { kind: "artifact"; id: string; artifactId: string }
  | { kind: "error"; id: string; message: string; retryable: boolean };
