import { useState } from "react";
import type { ApprovalDecision, ToolCallView, ToolResultView } from "../types.ts";

const ORIGIN_LABEL: Record<ToolCallView["origin"], string> = {
  local: "local",
  mcp: "MCP",
  foundry: "Foundry",
};

function formatArgs(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function summarize(call: ToolCallView): string {
  const a = call.args as Record<string, unknown> | null;
  if (a && typeof a === "object") {
    const first = a["path"] ?? a["url"] ?? a["command"] ?? a["query"];
    if (typeof first === "string") return first;
  }
  return "";
}

export function ToolCard({
  call,
  result,
  decision,
}: {
  call: ToolCallView;
  result?: ToolResultView;
  decision?: ApprovalDecision;
}): JSX.Element {
  const [open, setOpen] = useState(false);

  const state = !result
    ? decision === "deny"
      ? "denied"
      : "running"
    : result.denied
      ? "denied"
      : result.ok
        ? "ok"
        : "failed";

  const subject = summarize(call);

  return (
    <div className={`tool tool--${state}`}>
      <button
        type="button"
        className="tool__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`tool__dot tool__dot--${state}`} aria-hidden="true" />
        <span className="tool__name">{call.name}</span>
        {subject && <span className="tool__subject">{subject}</span>}
        <span className="tool__origin">
          {call.serverLabel ?? ORIGIN_LABEL[call.origin]}
        </span>
        {result && result.durationMs > 0 && (
          <span className="tool__ms">{result.durationMs}ms</span>
        )}
        <span className="tool__chev" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="tool__body">
          <div className="tool__section">
            <span className="tool__label">Arguments</span>
            <pre>{formatArgs(call.args)}</pre>
          </div>
          {result && (
            <div className="tool__section">
              <span className="tool__label">{result.ok ? "Result" : "Error"}</span>
              <pre>{result.output}</pre>
            </div>
          )}
          {!result && state === "running" && <div className="tool__pending">Running…</div>}
        </div>
      )}
    </div>
  );
}
