import { config } from "./config.js";

/**
 * What a turn is addressed to.
 *
 * Foundry can answer in two ways, and the harness supports both so that
 * switching model is a dropdown rather than a deployment:
 *
 *  · `agent`  — a hosted agent. It owns its model, instructions and tools; the
 *               request carries only an agent reference. This is the thing you
 *               built in the portal.
 *  · `model`  — a bare model deployment. Nothing server-side carries
 *               instructions or tools, so the harness supplies both inline on
 *               every call. Local tools therefore work with any deployed model
 *               without creating an agent version for it.
 */
export type Target =
  | { kind: "agent"; name: string }
  | { kind: "model"; deployment: string };

export interface TargetOption {
  /** Stable id used by the UI and persisted per conversation. */
  id: string;
  kind: Target["kind"];
  label: string;
  /** Publisher/model detail for a deployment, or the pinned model for an agent. */
  detail?: string;
  /** True when this is the agent named in the environment. */
  isDefault: boolean;
  /** Agents own their tools; bare models get the harness's tools injected. */
  toolSource: "agent" | "harness";
}

export function targetId(t: Target): string {
  return t.kind === "agent" ? `agent:${t.name}` : `model:${t.deployment}`;
}

export function parseTargetId(id: unknown): Target | null {
  if (typeof id !== "string") return null;
  const i = id.indexOf(":");
  if (i < 1) return null;
  const kind = id.slice(0, i);
  const rest = id.slice(i + 1);
  if (!rest) return null;
  if (kind === "agent") return { kind: "agent", name: rest };
  if (kind === "model") return { kind: "model", deployment: rest };
  return null;
}

export function defaultTarget(): Target {
  return { kind: "agent", name: config.foundry.agentName };
}

/** Human label for a target, for logs and the UI fallback. */
export function describeTarget(t: Target): string {
  return t.kind === "agent" ? t.name : t.deployment;
}
