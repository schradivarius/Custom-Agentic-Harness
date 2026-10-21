import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";
import type OpenAI from "openai";
import { config } from "./config.js";
import { toolSchemasForFoundry } from "./tools.js";
import { createMockOpenAI, mockHealthDetail, mockTargets } from "./mock.js";
import {
  defaultTarget,
  describeTarget,
  targetId,
  type Target,
  type TargetOption,
} from "./targets.js";

/**
 * Thin wrapper over the Foundry project client.
 *
 * Two details this exists to absorb:
 *
 *  1. Agent reference. A Responses call can be pointed at a hosted agent either
 *     by binding the agent to the OpenAI client (`azureConfig.agentName`) or by
 *     overriding the request body per call. The Azure JS samples disagree on the
 *     body key — `agentFunctionTool.ts` binds on the client, while `agentMcp.ts`
 *     sends `agent_reference` and the package README shows `agent`. Client
 *     binding avoids the question, so it is the default; `body` mode is kept for
 *     projects where binding is unavailable.
 *
 *  2. Credentials. DefaultAzureCredential resolves `az login`, managed identity
 *     or a service principal. Tokens stay in this process and are never sent to
 *     the browser.
 */

let project: AIProjectClient | undefined;

/** How the agent reference actually travels, once known. */
export type RefMode = "client" | "body";

/**
 * One OpenAI client per (target, ref mode). An agent is bound at client
 * construction in `client` mode, so a single shared client cannot serve two
 * agents — nor both modes for one agent while we are probing which works.
 */
const clients = new Map<string, OpenAI>();

/** Result of the one-time probe, when FOUNDRY_AGENT_REF_MODE=auto. */
let probed: RefMode | undefined;
let probeInFlight: Promise<RefMode> | undefined;

export function getProject(): AIProjectClient {
  if (config.foundry.mock) {
    throw new Error("The project client is unavailable in mock mode.");
  }
  project ??= new AIProjectClient(config.foundry.endpoint, new DefaultAzureCredential());
  return project;
}

export function getOpenAI(target: Target = defaultTarget(), mode: RefMode = "client"): OpenAI {
  const key = `${targetId(target)}|${mode}`;
  const cached = clients.get(key);
  if (cached) return cached;

  let client: OpenAI;
  if (config.foundry.mock) {
    client = createMockOpenAI(
      target.kind === "agent" ? { kind: "agent", name: target.name } : { kind: "model" },
    ) as OpenAI;
  } else {
    const p = getProject() as any;
    client =
      target.kind === "agent" && mode === "client"
        ? p.getOpenAIClient({
            azureConfig: { allowPreview: true, agentName: target.name },
          })
        : p.getOpenAIClient();
  }
  clients.set(key, client);
  return client;
}

/**
 * Settle how the agent reference travels, once per process.
 *
 * The Azure JS samples disagree: `agentFunctionTool.ts` binds the agent to the
 * client, `agentMcp.ts` sends `agent_reference` in the body, and the package
 * README shows `agent`. Rather than make that a setting someone has to debug
 * on their first run, `auto` sends one tiny request each way and keeps
 * whichever the project accepts. Pin `client` or `body` to skip the probe.
 */
export async function ensureAgentRefMode(target: Target): Promise<RefMode> {
  // A bare model deployment carries no agent reference at all.
  if (target.kind !== "agent") return "client";
  if (config.foundry.agentRefMode !== "auto") return config.foundry.agentRefMode;
  if (config.foundry.mock && !config.foundry.mockRefMode) return "client";
  if (probed) return probed;
  if (probeInFlight) return probeInFlight;

  probeInFlight = (async (): Promise<RefMode> => {
    const errors: string[] = [];
    for (const mode of ["client", "body"] as const) {
      try {
        const client = getOpenAI(target, mode) as any;
        await client.responses.create({
          ...paramsForTarget(target, mode),
          input: [{ type: "message", role: "user", content: "ping" }],
          max_output_tokens: 16,
        });
        probed = mode;
        console.log(`[foundry] agent reference mode resolved to "${mode}"`);
        return mode;
      } catch (err: any) {
        errors.push(`${mode}: ${String(err?.message ?? err).slice(0, 160)}`);
      }
    }
    // Both failed — the cause is almost certainly not the reference shape
    // (bad credential, wrong agent name, no access). Fall back to the
    // documented default and let the real call report the real error.
    console.warn(`[foundry] could not resolve agent reference mode:\n  ${errors.join("\n  ")}`);
    probeInFlight = undefined;
    return "client";
  })();

  return probeInFlight;
}

/** The mode in effect, for display. "auto" until the probe has run. */
export function currentAgentRefMode(): string {
  if (config.foundry.agentRefMode !== "auto") return config.foundry.agentRefMode;
  return probed ? `auto → ${probed}` : "auto (unresolved)";
}

/**
 * The per-request params that address a turn at `target`.
 *
 * An agent supplies its own model, instructions and tools, so the request stays
 * nearly empty. A bare model deployment supplies none of those, so the harness
 * sends its system prompt and local tool schemas inline — which is what lets
 * local tools work against any deployed model with no agent version.
 */
export function paramsForTarget(target: Target, mode: RefMode = "client"): Record<string, unknown> {
  if (target.kind === "model") {
    return {
      model: target.deployment,
      instructions: config.foundry.modelInstructions,
      tools: toolSchemasForFoundry(),
    };
  }
  if (mode === "client") return {};
  return {
    // In `body` mode the reference travels as an extra body field rather than
    // through the SDK's per-request `body` override, which replaces the payload
    // rather than extending it. Unknown body keys are passed through untouched.
    agent_reference: { name: target.name, type: "agent_reference" },
    ...(config.foundry.modelName ? { model: config.foundry.modelName } : {}),
  };
}

/** Does the harness have to execute this target's function tools itself? */
export function toolSourceFor(target: Target): "agent" | "harness" {
  return target.kind === "agent" ? "agent" : "harness";
}

/* ───────────────────────── discovery ───────────────────────── */

/**
 * Everything this project can be pointed at: the hosted agents, and every model
 * deployment in the project.
 *
 * Both listings are best-effort. A project where the caller cannot enumerate
 * agents still works — the configured agent is always offered — so a missing
 * permission degrades the picker rather than breaking the app.
 */
export async function listTargets(): Promise<TargetOption[]> {
  const options: TargetOption[] = [];
  const seen = new Set<string>();

  /* Utility agents are hidden from the picker: chatting with a titling agent
     produces nonsense, so offering it is a trap. The configured chat agent is
     never hidden, even if it were listed here by mistake. */
  const hidden = new Set(
    [config.foundry.titleAgent, ...config.foundry.hiddenAgents]
      .map((n) => n.trim())
      .filter((n) => n && n !== config.foundry.agentName),
  );
  const push = (o: TargetOption): void => {
    if (seen.has(o.id)) return;
    seen.add(o.id);
    options.push(o);
  };

  // The configured agent is always present, listable or not.
  push({
    id: `agent:${config.foundry.agentName}`,
    kind: "agent",
    label: config.foundry.agentName,
    isDefault: true,
    toolSource: "agent",
  });

  if (config.foundry.mock) {
    return mockTargets().filter((o) => !(o.kind === "agent" && hidden.has(o.label)));
  }

  const p = getProject() as any;

  try {
    const iter = p.agents?.list?.();
    if (iter) {
      for await (const a of iter) {
        const name = String(a?.name ?? "");
        if (!name || hidden.has(name)) continue;
        push({
          id: `agent:${name}`,
          kind: "agent",
          label: name,
          ...(a?.model ? { detail: String(a.model) } : {}),
          isDefault: name === config.foundry.agentName,
          toolSource: "agent",
        });
      }
    }
  } catch (err: any) {
    console.warn("[targets] could not list agents:", err?.message ?? err);
  }

  try {
    const iter = p.deployments?.list?.();
    if (iter) {
      for await (const d of iter) {
        if (d?.type !== "ModelDeployment") continue;
        const name = String(d?.name ?? "");
        if (!name) continue;
        // Embedding deployments show up in the same listing but cannot hold a
        // conversation; offering one as a chat target only produces a
        // confusing error when it is picked. Name-based because the listing
        // carries no capability field to test.
        if (/embed/i.test(name) || /embed/i.test(String(d?.modelName ?? ""))) continue;
        const detail = [d?.modelPublisher, d?.modelName].filter(Boolean).join(" · ");
        push({
          id: `model:${name}`,
          kind: "model",
          label: name,
          ...(detail ? { detail } : {}),
          isDefault: false,
          toolSource: "harness",
        });
      }
    }
  } catch (err: any) {
    console.warn("[targets] could not list model deployments:", err?.message ?? err);
  }

  return options;
}

/* ───────────────────────── agent versions ───────────────────── */

/**
 * Publish this harness's local function tools as a new version of the agent.
 *
 * Foundry only surfaces `function_call` items for tools the agent version
 * actually declares, so an agent-mode target has to be told about them. Off by
 * default: if you curate tools in the portal, an unexpected new version is the
 * last thing you want on boot. Model-mode targets never need this — their tools
 * are sent inline on every call.
 */
export async function syncLocalToolsToAgent(): Promise<{ version: string } | null> {
  if (config.foundry.mock || !config.foundry.syncTools) return null;
  if (!config.foundry.modelName) {
    throw new Error("FOUNDRY_SYNC_TOOLS=true requires FOUNDRY_MODEL_NAME to be set.");
  }
  const agents = (getProject() as any).agents;
  const created = await agents.createVersion(config.foundry.agentName, {
    kind: "prompt",
    model: config.foundry.modelName,
    instructions: config.foundry.modelInstructions,
    tools: toolSchemasForFoundry(),
  });
  return { version: String(created?.version ?? "unknown") };
}

/* ─────────────────────────── titling ────────────────────────── */

/** Logged once, not per conversation, when titling cannot run. */
let titleWarned = false;

/**
 * Summarise an opening exchange into a short conversation title.
 *
 * Deliberately not addressed at the hosted agent: its instructions and tools
 * apply to every call it receives, so asking it for a title can set a tool
 * loop running. This goes to a bare deployment with no tools and a tight
 * output cap.
 *
 * Returns null on any failure. A conversation keeps its first-message title
 * in that case, which is serviceable — never worth failing a turn over.
 */
export async function generateTitle(
  userText: string,
  assistantText: string,
): Promise<string | null> {
  if (!config.foundry.titles) return null;

  const agentName = config.foundry.titleAgent;
  const model = config.foundry.titleModel;
  if (!agentName && !model) {
    if (!titleWarned) {
      titleWarned = true;
      console.warn(
        "[foundry] neither FOUNDRY_TITLE_AGENT nor FOUNDRY_TITLE_MODEL / " +
          "FOUNDRY_MODEL_NAME is set, so conversations keep their " +
          "first-message titles.",
      );
    }
    return null;
  }

  const exchange = `User: ${userText.slice(0, 1200)}\n\nAssistant: ${assistantText.slice(0, 1200)}`;

  /* A dedicated agent carries its own system prompt, so none is sent — its
     wording lives in the portal. A bare deployment carries nothing, so the
     instruction goes inline. Neither path sends tools. */
  const target: Target = agentName
    ? { kind: "agent", name: agentName }
    : { kind: "model", deployment: model };

  try {
    const mode = await ensureAgentRefMode(target);
    const client = getOpenAI(target, mode) as any;
    const addressing = agentName
      ? paramsForTarget(target, mode)
      : {
          model,
          instructions:
            "Title this exchange in at most six words. Reply with the title alone: " +
            "no quotation marks, no trailing period, no preamble.",
        };
    const res = await client.responses.create(
      {
        ...addressing,
        input: [{ type: "message", role: "user", content: exchange }],
        // Generous for six words on purpose: on a reasoning deployment this
        // budget covers reasoning tokens too, and a tight cap gets spent
        // thinking, returning empty output_text and no title at all.
        max_output_tokens: 10000,
      },
      { signal: AbortSignal.timeout(15_000) },
    );
    return cleanTitle(String(res?.output_text ?? ""));
  } catch (err: any) {
    console.warn("[foundry] could not generate a title:", String(err?.message ?? err).slice(0, 140));
    return null;
  }
}

/** Models like to add quotes, trailing stops and "Title:" whatever you ask. */
export function cleanTitle(raw: string): string | null {
  let t = raw.trim().split("\n")[0]?.trim() ?? "";
  t = t.replace(/^(title|chat title)\s*[:\-—]\s*/i, "");
  t = t.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "");
  t = t.replace(/[.\s]+$/, "");
  t = t.trim();
  if (!t || t.length < 2) return null;
  return t.length > 60 ? `${t.slice(0, 57).trimEnd()}…` : t;
}

/* ───────────────────────── conversations ────────────────────── */

export async function createConversation(target?: Target): Promise<string> {
  const client = getOpenAI(target) as any;
  const conv = await client.conversations.create({});
  return String(conv.id);
}

export async function deleteConversation(id: string, target?: Target): Promise<void> {
  const client = getOpenAI(target) as any;
  await client.conversations.delete(id);
}

export async function appendUserMessage(
  conversationId: string,
  text: string,
  target?: Target,
): Promise<void> {
  const client = getOpenAI(target) as any;
  await client.conversations.items.create(conversationId, {
    items: [{ type: "message", role: "user", content: text }],
  });
}

/* ───────────────────────────── health ───────────────────────── */

export interface HealthReport {
  ok: boolean;
  endpoint: string;
  agentName: string;
  agentRefMode: string;
  localTools: string[];
  detail?: string;
}

export async function health(): Promise<HealthReport> {
  const base: Omit<HealthReport, "ok"> = {
    endpoint: config.foundry.endpoint,
    agentName: config.foundry.agentName,
    agentRefMode: currentAgentRefMode(),
    localTools: toolSchemasForFoundry().map((t) => String(t["name"])),
  };
  if (config.foundry.mock) {
    return { ok: true, ...base, detail: mockHealthDetail() };
  }
  try {
    const agents = (getProject() as any).agents;
    // Cheapest call that proves both credentials and agent name are good.
    await agents.getVersion?.(config.foundry.agentName).catch(async () => {
      await agents.get?.(config.foundry.agentName);
    });
    return { ok: true, ...base };
  } catch (err: any) {
    return { ok: false, ...base, detail: err?.message ?? String(err) };
  }
}

export { describeTarget };
