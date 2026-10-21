import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, streamTurn } from "./api.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { Composer } from "./components/Composer.tsx";
import { ToolCard } from "./components/ToolCard.tsx";
import { ApprovalCard } from "./components/ApprovalCard.tsx";
import { Markdown } from "./components/Markdown.tsx";
import { Thinking } from "./components/Thinking.tsx";
import { TargetPicker } from "./components/TargetPicker.tsx";
import type {
  ApprovalDecision,
  Block,
  ConversationMeta,
  HarnessEvent,
  HealthReport,
  TargetOption,
  ToolInfo,
} from "./types.ts";

let seq = 0;
const nextId = (): string => `b${++seq}`;

export default function App(): JSX.Element {
  const sessionId = useMemo(
    () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())),
    [],
  );

  const [health, setHealth] = useState<HealthReport | null>(null);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [targets, setTargets] = useState<TargetOption[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  /* ── bootstrap ─────────────────────────────────────────────────── */

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await api.listConversations());
    } catch (err) {
      console.warn("could not list conversations", err);
    }
  }, []);

  useEffect(() => {
    void api
      .health()
      .then(setHealth)
      .catch((err: unknown) =>
        setHealth({
          ok: false,
          endpoint: "—",
          agentName: "unreachable",
          agentRefMode: "—",
          localTools: [],
          detail: String(err instanceof Error ? err.message : err),
          autoApprove: [],
          shellEnabled: false,
          workspaceRoot: "—",
        }),
      );
    void api
      .listTargets()
      .then((list) => {
        setTargets(list);
        setTargetId((cur) => cur ?? list.find((t) => t.isDefault)?.id ?? list[0]?.id ?? null);
      })
      .catch((err: unknown) => console.warn("could not list targets", err));
    void api
      .listTools()
      .then(setTools)
      .catch((err: unknown) => console.warn("could not list tools", err));
    void refreshConversations();
  }, [refreshConversations]);

  /* Keep the view pinned to the newest output unless the user scrolled up. */
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [blocks]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  /* ── event folding ─────────────────────────────────────────────── */

  const apply = useCallback((event: HarnessEvent) => {
    setBlocks((prev) => {
      const out = [...prev];
      const last = out[out.length - 1];

      switch (event.type) {
        case "text.delta": {
          if (last?.kind === "assistant" && last.streaming) {
            out[out.length - 1] = { ...last, text: last.text + event.delta };
          } else {
            out.push({ kind: "assistant", id: nextId(), text: event.delta, streaming: true });
          }
          return out;
        }

        case "text.done": {
          if (last?.kind === "assistant" && last.streaming) {
            out[out.length - 1] = { ...last, text: event.text };
          }
          return out;
        }

        case "tool.call": {
          // Close any open prose block so the tool card reads in sequence.
          if (last?.kind === "assistant" && last.streaming) {
            out[out.length - 1] = { ...last, streaming: false };
          }
          out.push({ kind: "tool", id: event.call.id, call: event.call });
          return out;
        }

        case "approval.required": {
          const i = out.findIndex(
            (b) => b.kind === "tool" && b.call.id === event.request.toolCallId,
          );
          if (i >= 0) {
            const b = out[i];
            if (b?.kind === "tool") out[i] = { ...b, approval: event.request };
          }
          return out;
        }

        case "approval.resolved": {
          const i = out.findIndex(
            (b) => b.kind === "tool" && b.approval?.approvalId === event.approvalId,
          );
          if (i >= 0) {
            const b = out[i];
            if (b?.kind === "tool") {
              const { approval: _drop, ...rest } = b;
              out[i] = { ...rest, decision: event.decision };
            }
          }
          return out;
        }

        case "tool.result": {
          const i = out.findIndex((b) => b.kind === "tool" && b.call.id === event.result.id);
          if (i >= 0) {
            const b = out[i];
            if (b?.kind === "tool") out[i] = { ...b, result: event.result };
          }
          return out;
        }

        case "turn.done": {
          for (let i = out.length - 1; i >= 0; i--) {
            const b = out[i];
            if (b?.kind === "assistant" && b.streaming) {
              out[i] = {
                ...b,
                streaming: false,
                ...(event.usage ? { usage: event.usage } : {}),
                ...(event.targetId ? { targetId: event.targetId } : {}),
              };
              break;
            }
          }
          return out;
        }

        case "error": {
          if (last?.kind === "assistant" && last.streaming) {
            out[out.length - 1] = { ...last, streaming: false };
          }
          out.push({
            kind: "error",
            id: nextId(),
            message: event.message,
            retryable: event.retryable,
          });
          return out;
        }

        default:
          return out;
      }
    });
  }, []);

  /* ── actions ───────────────────────────────────────────────────── */

  const send = useCallback(
    async (text: string) => {
      setBlocks((prev) => [...prev, { kind: "user", id: nextId(), text }]);
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await streamTurn(
          {
            message: text,
            sessionId,
            ...(activeId ? { conversationId: activeId } : {}),
            ...(targetId ? { targetId } : {}),
          },
          (event) => {
            if (event.type === "conversation") {
              setActiveId(event.conversationId);
              void refreshConversations();
              return;
            }
            if (event.type === "conversation.titled") {
              // Patch in place: a refetch would reorder the list mid-read.
              setConversations((prev) =>
                prev.map((c) =>
                  c.id === event.conversationId ? { ...c, title: event.title } : c,
                ),
              );
              return;
            }
            apply(event);
          },
          controller.signal,
        );
      } catch (err: unknown) {
        if (!controller.signal.aborted) {
          apply({
            type: "error",
            message: String(err instanceof Error ? err.message : err),
            retryable: true,
          });
        }
      } finally {
        setBusy(false);
        abortRef.current = null;
        void refreshConversations();
      }
    },
    [activeId, apply, refreshConversations, sessionId, targetId],
  );

  const stop = useCallback(() => {
    void api.abort(sessionId).catch(() => undefined);
    abortRef.current?.abort();
    setBusy(false);
  }, [sessionId]);

  const decide = useCallback(
    async (approvalId: string, decision: ApprovalDecision) => {
      setDeciding(approvalId);
      try {
        await api.decideApproval(approvalId, decision);
      } catch (err: unknown) {
        apply({
          type: "error",
          message: `Could not record that decision: ${String(
            err instanceof Error ? err.message : err,
          )}`,
          retryable: false,
        });
      } finally {
        setDeciding(null);
      }
    },
    [apply],
  );

  const openConversation = useCallback(async (id: string, pinned?: string) => {
    setActiveId(id);
    setBlocks([]);
    if (pinned) setTargetId(pinned);
    try {
      const turns = await api.getTurns(id);
      const rebuilt: Block[] = [];
      for (const t of turns) {
        if (t.role === "user") {
          rebuilt.push({ kind: "user", id: nextId(), text: t.text });
          continue;
        }
        for (const call of t.toolCalls ?? []) {
          const result = (t.toolResults ?? []).find((r) => r.id === call.id);
          rebuilt.push({ kind: "tool", id: call.id, call, ...(result ? { result } : {}) });
        }
        if (t.text) {
          rebuilt.push({
            kind: "assistant",
            id: nextId(),
            text: t.text,
            streaming: false,
            ...(t.targetId ? { targetId: t.targetId } : {}),
          });
        }
      }
      setBlocks(rebuilt);
    } catch (err) {
      console.warn("could not load transcript", err);
    }
  }, []);

  const newChat = useCallback(() => {
    setActiveId(null);
    setBlocks([]);
  }, []);

  const removeConversation = useCallback(
    async (id: string) => {
      await api.deleteConversation(id).catch(() => undefined);
      if (id === activeId) newChat();
      void refreshConversations();
    },
    [activeId, newChat, refreshConversations],
  );

  /* ── render ────────────────────────────────────────────────────── */

  /*
   * Show the indicator only when nothing else already says "wait".
   * Streaming text has its own caret; a tool still running has its own
   * spinner on the card; and an approval prompt is waiting on the human,
   * not on the agent — claiming to think there would be a lie.
   */
  const last = blocks[blocks.length - 1];
  const awaitingApproval = blocks.some((b) => b.kind === "tool" && b.approval);
  const streamingText = last?.kind === "assistant" && last.streaming;
  const toolRunning = last?.kind === "tool" && !last.result;
  const thinking = busy && !awaitingApproval && !streamingText && !toolRunning;

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        health={health}
        tools={tools}
        onSelect={(id) =>
          void openConversation(id, conversations.find((c) => c.id === id)?.targetId)
        }
        onNew={newChat}
        onDelete={(id) => void removeConversation(id)}
      />

      <main className="main">
        <header className="topbar">
          <TargetPicker
            targets={targets}
            value={targetId}
            onChange={setTargetId}
            disabled={busy}
          />
        </header>

        <div className="thread" ref={scrollRef} onScroll={onScroll}>
          {blocks.length === 0 && (
            <div className="welcome">
              <h1>Your Foundry agent, on your desk</h1>
              <p>
                Messages go to <strong>{health?.agentName ?? "your agent"}</strong> in Microsoft
                Foundry. The agent runs on the service; its tool calls run here, and pause for your
                approval first.
              </p>
              {health?.localTools.length ? (
                <ul className="welcome__tools">
                  {health.localTools.map((t) => (
                    <li key={t}>
                      <code>{t}</code>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}

          {blocks.map((b) => {
            if (b.kind === "user") {
              return (
                <div key={b.id} className="turn turn--user">
                  <div className="bubble">{b.text}</div>
                </div>
              );
            }
            if (b.kind === "assistant") {
              return (
                <div key={b.id} className="turn turn--assistant">
                  <Markdown text={b.text} />
                  {b.streaming && <span className="caret" aria-label="generating" />}
                  {(b.targetId || b.usage?.total != null) && !b.streaming && (
                    <span className="usage">
                      {b.targetId && (
                        <span className="usage__target">
                          {targets.find((t) => t.id === b.targetId)?.label ??
                            b.targetId.replace(/^(agent|model):/, "")}
                        </span>
                      )}
                      {b.usage?.total != null && <span>{b.usage.total} tokens</span>}
                    </span>
                  )}
                </div>
              );
            }
            if (b.kind === "tool") {
              return (
                <div key={b.id} className="turn turn--tool">
                  <ToolCard
                    call={b.call}
                    {...(b.result ? { result: b.result } : {})}
                    {...(b.decision ? { decision: b.decision } : {})}
                  />
                  {b.approval && (
                    <ApprovalCard
                      request={b.approval}
                      busy={deciding === b.approval.approvalId}
                      onDecide={(d) => void decide(b.approval!.approvalId, d)}
                    />
                  )}
                </div>
              );
            }
            return (
              <div key={b.id} className="turn turn--error">
                <div className="error">
                  <strong>Something went wrong.</strong>
                  <span>{b.message}</span>
                  {b.retryable && <em>This one is worth retrying.</em>}
                </div>
              </div>
            );
          })}

          {thinking && <Thinking />}
        </div>

        <Composer
          onSend={(t) => void send(t)}
          onStop={stop}
          busy={busy}
          disabled={health !== null && !health.ok}
        />
      </main>
    </div>
  );
}
