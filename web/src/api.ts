import type {
  ApprovalDecision,
  ArtifactView,
  ConversationMeta,
  HarnessEvent,
  HealthReport,
  StoredTurn,
  TargetOption,
  ToolInfo,
} from "./types.ts";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const api = {
  health: (): Promise<HealthReport> => fetch("/api/health").then(json<HealthReport>),

  listTargets: (): Promise<TargetOption[]> => fetch("/api/targets").then(json<TargetOption[]>),

  listTools: (): Promise<ToolInfo[]> => fetch("/api/tools").then(json<ToolInfo[]>),

  listConversations: (): Promise<ConversationMeta[]> =>
    fetch("/api/conversations").then(json<ConversationMeta[]>),

  createConversation: (): Promise<ConversationMeta> =>
    fetch("/api/conversations", { method: "POST" }).then(json<ConversationMeta>),

  deleteConversation: (id: string): Promise<{ ok: boolean }> =>
    fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }).then(
      json<{ ok: boolean }>,
    ),

  getTurns: (id: string): Promise<StoredTurn[]> =>
    fetch(`/api/conversations/${encodeURIComponent(id)}/turns`).then(json<StoredTurn[]>),

  listArtifacts: (conversationId: string): Promise<ArtifactView[]> =>
    fetch(`/api/conversations/${encodeURIComponent(conversationId)}/artifacts`).then(
      json<ArtifactView[]>,
    ),

  getArtifact: (id: string, version?: number): Promise<ArtifactView> =>
    fetch(
      `/api/artifacts/${encodeURIComponent(id)}` +
        (version === undefined ? "" : `?version=${version}`),
    ).then(json<ArtifactView>),

  /** The browser fetches this itself; we only build the URL. */
  downloadUrl: (id: string, version?: number): string =>
    `/api/artifacts/${encodeURIComponent(id)}/download` +
    (version === undefined ? "" : `?version=${version}`),

  decideApproval: (approvalId: string, decision: ApprovalDecision): Promise<{ ok: boolean }> =>
    fetch(`/api/approvals/${encodeURIComponent(approvalId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    }).then(json<{ ok: boolean }>),

  abort: (sessionId: string): Promise<{ ok: boolean }> =>
    fetch("/api/chat/abort", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).then(json<{ ok: boolean }>),
};

/**
 * Stream one turn.
 *
 * EventSource cannot POST, and the message belongs in a body rather than a URL,
 * so this reads the SSE response off fetch directly and parses the frames.
 */
export async function streamTurn(
  body: { message: string; conversationId?: string; sessionId: string; targetId?: string },
  onEvent: (event: HarnessEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Chat request failed: ${res.status} ${res.statusText}`);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;

    // SSE frames are separated by a blank line.
    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");

      if (!data) continue; // comment frame, e.g. the keep-alive ping
      try {
        onEvent(JSON.parse(data) as HarnessEvent);
      } catch {
        console.warn("[sse] unparseable frame", data);
      }
    }
  }
}
