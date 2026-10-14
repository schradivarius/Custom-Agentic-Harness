import { useEffect, useState } from "react";
import type { ApprovalDecision, ApprovalRequestView } from "../types.ts";

const RISK_COPY: Record<ApprovalRequestView["risk"], string> = {
  safe: "Read-only",
  caution: "Makes a change",
  dangerous: "Runs a command",
};

function useCountdown(expiresAt: number): number {
  const [left, setLeft] = useState(() => Math.max(0, expiresAt - Date.now()));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, expiresAt - Date.now())), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  return left;
}

export function ApprovalCard({
  request,
  onDecide,
  busy,
}: {
  request: ApprovalRequestView;
  onDecide: (decision: ApprovalDecision) => void;
  busy: boolean;
}): JSX.Element {
  const left = useCountdown(request.expiresAt);
  const [showArgs, setShowArgs] = useState(false);
  const seconds = Math.ceil(left / 1000);

  return (
    <div className={`approval approval--${request.risk}`} role="group" aria-label="Tool approval">
      <div className="approval__top">
        <span className="approval__badge">{RISK_COPY[request.risk]}</span>
        <span className="approval__title">
          <strong>{request.name}</strong>
          {request.serverLabel && <span className="approval__server"> · {request.serverLabel}</span>}
        </span>
        {seconds > 0 && <span className="approval__timer">{seconds}s</span>}
      </div>

      <p className="approval__preview">{request.preview}</p>

      <button type="button" className="approval__toggle" onClick={() => setShowArgs((v) => !v)}>
        {showArgs ? "Hide arguments" : "Show arguments"}
      </button>
      {showArgs && <pre className="approval__args">{JSON.stringify(request.args, null, 2)}</pre>}

      <div className="approval__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || seconds === 0}
          onClick={() => onDecide("once")}
        >
          Allow once
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || seconds === 0}
          onClick={() => onDecide("session")}
        >
          Allow for session
        </button>
        <button
          type="button"
          className="btn btn--danger"
          disabled={busy}
          onClick={() => onDecide("deny")}
        >
          Deny
        </button>
      </div>

      {seconds === 0 && (
        <p className="approval__expired">
          This request timed out and was refused. Ask again to retry it.
        </p>
      )}
    </div>
  );
}
