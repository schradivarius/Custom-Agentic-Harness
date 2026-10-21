import { randomUUID } from "node:crypto";
import { approvalGate } from "./approvals.js";
import { ensureAgentRefMode, generateTitle, getOpenAI, paramsForTarget } from "./foundry.js";
import { defaultTarget, targetId, type Target } from "./targets.js";
import { registry } from "./tools.js";
import { store } from "./store.js";
import type {
  ApprovalDecision,
  HarnessEvent,
  RiskTier,
  TokenUsage,
  ToolCallView,
  ToolOrigin,
  ToolResultView,
} from "./protocol.js";

/**
 * Bound on tool rounds per user turn. Each round is one Responses call, so this
 * caps both spend and the blast radius of a model that loops on a failing tool.
 */
const MAX_TOOL_ROUNDS = 12;

export interface RunTurnOptions {
  conversationId: string;
  userText: string;
  /** Scope for "allow for the rest of this session" grants. */
  sessionId: string;
  /** The agent or model deployment this turn is addressed to. */
  target?: Target;
  emit: (event: HarnessEvent) => void;
  signal: AbortSignal;
}

/** Items we hand back to Foundry to continue a paused turn. */
type ContinuationItem =
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "mcp_approval_response"; approval_request_id: string; approve: boolean; reason?: string };

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function clipForUi(text: string, max = 4_000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated]`;
}

function usageOf(response: any): TokenUsage | undefined {
  const u = response?.usage;
  if (!u) return undefined;
  return {
    ...(u.input_tokens != null ? { input: Number(u.input_tokens) } : {}),
    ...(u.output_tokens != null ? { output: Number(u.output_tokens) } : {}),
    ...(u.total_tokens != null ? { total: Number(u.total_tokens) } : {}),
  };
}

/**
 * Run one user turn to completion.
 *
 * Foundry holds the transcript, so each round sends only what is new: the user
 * message on the first round, then tool outputs chained onto the previous
 * response. Between rounds every requested tool call passes through the
 * approval gate, and a denial is reported back to the model as a tool result
 * rather than dropped — the model is told it was refused and can adapt.
 */
export async function runTurn(opts: RunTurnOptions): Promise<void> {
  const { conversationId, userText, sessionId, emit, signal } = opts;
  const target = opts.target ?? defaultTarget();
  const tid = targetId(target);
  // Settles how the agent reference travels; a no-op after the first turn.
  const refMode = await ensureAgentRefMode(target);
  const client = getOpenAI(target, refMode) as any;

  store.appendTurn({
    conversationId,
    role: "user",
    text: userText,
    at: Date.now(),
    targetId: tid,
  });

  let params: Record<string, unknown> = {
    ...paramsForTarget(target, refMode),
    conversation: conversationId,
    input: [{ type: "message", role: "user", content: userText }],
  };

  let assistantText = "";
  const roundCalls: ToolCallView[] = [];
  const roundResults: ToolResultView[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal.aborted) throw new Error("aborted");

    let final: any;
    let textThisRound = "";

    const stream = client.responses.stream(params, { signal });

    for await (const event of stream) {
      if (signal.aborted) break;
      switch (event?.type) {
        case "response.created":
          emit({ type: "response.started", responseId: String(event.response?.id ?? "") });
          break;
        case "response.output_text.delta":
          textThisRound += String(event.delta ?? "");
          emit({ type: "text.delta", delta: String(event.delta ?? "") });
          break;
        case "response.output_text.done":
          emit({ type: "text.done", text: String(event.text ?? textThisRound) });
          break;
        case "response.reasoning_summary_text.delta":
          emit({ type: "reasoning.delta", delta: String(event.delta ?? "") });
          break;
        case "response.completed":
          final = event.response;
          break;
        case "response.failed":
        case "error":
          throw new Error(
            String(event.response?.error?.message ?? event.message ?? "Foundry stream error"),
          );
        default:
          break;
      }
    }

    final ??= await stream.finalResponse?.();
    if (!final) throw new Error("Foundry returned no response for this round.");

    assistantText += textThisRound;
    const responseId = String(final.id ?? "");
    store.touch(conversationId, { lastResponseId: responseId });

    const output: any[] = Array.isArray(final.output) ? final.output : [];
    const continuation: ContinuationItem[] = [];
    /** call_ids answered this round, to reconcile against the response. */
    const answered = new Set<string>();

    if (process.env["FOUNDRY_DEBUG"]) {
      console.log(
        `[harness] round ${round} output:`,
        output
          .map((i: any) => `${i?.type}${i?.call_id ? `(${i.call_id})` : ""}`)
          .join(", ") || "(empty)",
      );
    }

    for (const item of output) {
      /* ── Local function tools: this harness executes them ───────────── */
      if (item?.type === "function_call") {
        /* `call_id` and `id` are different fields: the service matches tool
           output on `call_id` (call_…), while `id` identifies the output item
           itself (fc_…). Submitting the wrong one is rejected with
           "No tool output found for function call call_…", so the id that
           goes back to the service is never substituted — only the id the UI
           keys on falls back. */
        const apiCallId =
          typeof item.call_id === "string" && item.call_id ? item.call_id : undefined;
        if (!apiCallId) {
          console.warn(
            `[harness] function_call "${item.name}" arrived without a call_id; ` +
              `keys present: ${Object.keys(item ?? {}).join(", ")}`,
          );
        }

        const call: ToolCallView = {
          id: apiCallId ?? String(item.id ?? randomUUID()),
          name: String(item.name ?? "unknown"),
          origin: "local",
          args: parseArgs(item.arguments),
        };
        roundCalls.push(call);
        emit({ type: "tool.call", call });

        const result = await executeLocal(call, sessionId, emit, signal);
        roundResults.push(result);
        emit({ type: "tool.result", result });

        if (apiCallId) answered.add(apiCallId);
        continuation.push({
          type: "function_call_output",
          call_id: apiCallId ?? call.id,
          output: result.ok
            ? result.output
            : JSON.stringify({ error: result.output, denied: result.denied ?? false }),
        });
        continue;
      }

      /* ── MCP tools: Foundry executes them, we gate them ─────────────── */
      if (item?.type === "mcp_approval_request") {
        const call: ToolCallView = {
          id: String(item.id),
          name: String(item.name ?? "unknown"),
          origin: "mcp",
          args: parseArgs(item.arguments),
          ...(item.server_label ? { serverLabel: String(item.server_label) } : {}),
        };
        roundCalls.push(call);
        emit({ type: "tool.call", call });

        const decision = await askApproval(
          {
            toolCallId: call.id,
            name: call.name,
            origin: "mcp",
            // An MCP call runs with the service's credentials against a remote
            // server, so it is never auto-approved as "safe".
            risk: "caution",
            args: call.args,
            preview: `${call.serverLabel ?? "mcp"} → ${call.name}`,
            sessionId,
            ...(call.serverLabel ? { serverLabel: call.serverLabel } : {}),
          },
          emit,
          signal,
        );

        const approve = decision !== "deny";
        emit({
          type: "tool.result",
          result: {
            id: call.id,
            name: call.name,
            ok: approve,
            output: approve ? "Approved — Foundry is running this tool." : "Denied by the user.",
            durationMs: 0,
            ...(approve ? {} : { denied: true }),
          },
        });

        continuation.push({
          type: "mcp_approval_response",
          approval_request_id: call.id,
          approve,
          ...(approve ? {} : { reason: "The user declined this tool call." }),
        });
        continue;
      }

      /* ── Already-executed service-side tools: surface for visibility ── */
      if (item?.type === "mcp_call" || item?.type === "code_interpreter_call") {
        const name =
          item.type === "mcp_call" ? String(item.name ?? "mcp_call") : "code_interpreter";
        const result: ToolResultView = {
          id: String(item.id ?? randomUUID()),
          name,
          ok: !item.error,
          output: clipForUi(
            String(item.error ?? item.output ?? item.code ?? "(ran in Foundry)"),
          ),
          durationMs: 0,
        };
        roundResults.push(result);
        emit({
          type: "tool.call",
          call: {
            id: result.id,
            name,
            origin: "foundry",
            args: parseArgs(item.arguments),
            ...(item.server_label ? { serverLabel: String(item.server_label) } : {}),
          },
        });
        emit({ type: "tool.result", result });
      }
    }

    /* Every function_call in the response must come back with output, or the
       next request is rejected outright and the whole turn is lost. If one
       slipped past the loop above, answer it with an error rather than let
       that happen — a failed tool is recoverable, a rejected request is not. */
    for (const item of output) {
      if (item?.type !== "function_call") continue;
      const id = typeof item.call_id === "string" ? item.call_id : "";
      if (!id || answered.has(id)) continue;
      console.warn(
        `[harness] no output was produced for function_call ${id} ("${item.name}"); ` +
          `returning an error for it so the turn can continue`,
      );
      continuation.push({
        type: "function_call_output",
        call_id: id,
        output: JSON.stringify({
          error: "The harness produced no output for this tool call.",
        }),
      });
    }

    /* Nothing left to satisfy — the turn is done. */
    if (continuation.length === 0) {
      store.appendTurn({
        conversationId,
        role: "assistant",
        text: assistantText,
        at: Date.now(),
        ...(roundCalls.length ? { toolCalls: roundCalls } : {}),
        ...(roundResults.length ? { toolResults: roundResults } : {}),
        targetId: tid,
      });
      const usage = usageOf(final);
      emit({ type: "turn.done", responseId, targetId: tid, ...(usage ? { usage } : {}) });

      /* Name the conversation from the opening exchange, once. The stream is
         still open, so the sidebar updates without a refetch. Any failure
         leaves the first-message title in place. */
      const turns = store.getTurns(conversationId);
      const meta = store.getConversation(conversationId);
      if (turns.length <= 2 && meta?.titleAuto !== false && assistantText.trim()) {
        const title = await generateTitle(userText, assistantText);
        if (title && store.setTitle(conversationId, title)) {
          emit({ type: "conversation.titled", conversationId, title });
        }
      }
      return;
    }

    /* Chain the next round onto this response. Per the Azure samples, a
       continuation carries `previous_response_id` and omits `conversation`. */
    // A bare model deployment carries nothing server-side, so its model,
    // instructions and tools go out again on every continuation round.
    params = {
      ...paramsForTarget(target, refMode),
      input: continuation,
      previous_response_id: responseId,
    };
  }

  throw new Error(
    `Stopped after ${MAX_TOOL_ROUNDS} tool rounds without the agent settling on an answer.`,
  );
}

async function askApproval(
  ask: Parameters<typeof approvalGate.ask>[0],
  emit: (e: HarnessEvent) => void,
  signal: AbortSignal,
): Promise<ApprovalDecision> {
  const { view, decision } = approvalGate.ask(ask);
  if (view) emit({ type: "approval.required", request: view });

  const aborted = new Promise<ApprovalDecision>((resolve) => {
    if (signal.aborted) return resolve("deny");
    signal.addEventListener("abort", () => resolve("deny"), { once: true });
  });

  const outcome = await Promise.race([decision, aborted]);
  if (view) emit({ type: "approval.resolved", approvalId: view.approvalId, decision: outcome });
  return outcome;
}

async function executeLocal(
  call: ToolCallView,
  sessionId: string,
  emit: (e: HarnessEvent) => void,
  signal: AbortSignal,
): Promise<ToolResultView> {
  const tool = registry.get(call.name);
  if (!tool) {
    return {
      id: call.id,
      name: call.name,
      ok: false,
      output: `No local tool named "${call.name}" is registered in this harness.`,
      durationMs: 0,
    };
  }

  let preview = call.name;
  try {
    preview = tool.preview(call.args);
  } catch {
    /* a preview failure must not block the call */
  }

  const decision = await askApproval(
    {
      toolCallId: call.id,
      name: call.name,
      origin: "local",
      risk: tool.risk as RiskTier,
      args: call.args,
      preview,
      sessionId,
    },
    emit,
    signal,
  );

  if (decision === "deny") {
    return {
      id: call.id,
      name: call.name,
      ok: false,
      output: "The user declined this tool call.",
      durationMs: 0,
      denied: true,
    };
  }

  const started = Date.now();
  try {
    const output = await tool.run(call.args);
    return {
      id: call.id,
      name: call.name,
      ok: true,
      output: clipForUi(output),
      durationMs: Date.now() - started,
    };
  } catch (err: any) {
    return {
      id: call.id,
      name: call.name,
      ok: false,
      output: clipForUi(String(err?.message ?? err)),
      durationMs: Date.now() - started,
    };
  }
}

export type { ToolOrigin };
