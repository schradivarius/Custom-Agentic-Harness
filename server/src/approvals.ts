import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import type { ApprovalDecision, ApprovalRequestView, RiskTier, ToolOrigin } from "./protocol.js";

interface Pending {
  view: ApprovalRequestView;
  resolve: (d: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
  sessionId: string;
}

export interface ApprovalAsk {
  toolCallId: string;
  name: string;
  origin: ToolOrigin;
  risk: RiskTier;
  args: unknown;
  preview: string;
  serverLabel?: string;
  /** Scope for "allow for the rest of this session" grants. */
  sessionId: string;
}

export interface ApprovalOutcome {
  /** Null when the call was approved by policy and no human was asked. */
  view: ApprovalRequestView | null;
  decision: Promise<ApprovalDecision>;
}

/**
 * Holds tool calls while a human decides.
 *
 * Calls whose risk tier is in AUTO_APPROVE never reach a human. Everything else
 * blocks until the UI posts a decision, the grant is already held for this
 * session, or APPROVAL_TIMEOUT_SECONDS elapses — a timeout denies, so a tab
 * closed mid-prompt can never leave a tool call silently approved.
 */
export class ApprovalGate {
  #pending = new Map<string, Pending>();
  #sessionGrants = new Map<string, Set<string>>();

  ask(req: ApprovalAsk): ApprovalOutcome {
    if (config.approvals.autoApprove.includes(req.risk)) {
      return { view: null, decision: Promise.resolve<ApprovalDecision>("once") };
    }
    if (this.#sessionGrants.get(req.sessionId)?.has(req.name)) {
      return { view: null, decision: Promise.resolve<ApprovalDecision>("session") };
    }

    const approvalId = randomUUID();
    const expiresAt = Date.now() + config.approvals.timeoutMs;
    const view: ApprovalRequestView = {
      approvalId,
      toolCallId: req.toolCallId,
      name: req.name,
      origin: req.origin,
      risk: req.risk,
      args: req.args,
      preview: req.preview,
      expiresAt,
      ...(req.serverLabel ? { serverLabel: req.serverLabel } : {}),
    };

    const decision = new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(approvalId);
        resolve("deny");
      }, config.approvals.timeoutMs);
      // Do not hold the process open just for a pending prompt.
      timer.unref?.();
      this.#pending.set(approvalId, { view, resolve, timer, sessionId: req.sessionId });
    });

    return { view, decision };
  }

  /** Returns false when the id is unknown or already decided. */
  resolve(approvalId: string, decision: ApprovalDecision): boolean {
    const p = this.#pending.get(approvalId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.#pending.delete(approvalId);

    if (decision === "session") {
      let grants = this.#sessionGrants.get(p.sessionId);
      if (!grants) {
        grants = new Set();
        this.#sessionGrants.set(p.sessionId, grants);
      }
      grants.add(p.view.name);
    }

    p.resolve(decision);
    return true;
  }

  /** Deny everything outstanding, e.g. when the user aborts the turn. */
  denyAll(sessionId?: string): void {
    for (const [id, p] of [...this.#pending]) {
      if (sessionId && p.sessionId !== sessionId) continue;
      this.resolve(id, "deny");
    }
  }

  listPending(sessionId?: string): ApprovalRequestView[] {
    return [...this.#pending.values()]
      .filter((p) => !sessionId || p.sessionId === sessionId)
      .map((p) => p.view);
  }

  grantsFor(sessionId: string): string[] {
    return [...(this.#sessionGrants.get(sessionId) ?? [])];
  }

  revokeGrants(sessionId: string): void {
    this.#sessionGrants.delete(sessionId);
  }
}

export const approvalGate = new ApprovalGate();
