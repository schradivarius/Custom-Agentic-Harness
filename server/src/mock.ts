import { randomUUID } from "node:crypto";
import type { TargetOption } from "./targets.js";
import { config } from "./config.js";

/**
 * When FOUNDRY_MOCK_REF_MODE is set, reject the shape the simulated project
 * does not accept — the same way a real project rejects the wrong one.
 */
function enforceRefMode(params: any): void {
  const want = config.foundry.mockRefMode;
  if (!want) return;
  const hasRef = Boolean(params?.agent_reference);
  if (want === "body" && !hasRef) {
    throw Object.assign(new Error("Unknown agent: request carried no agent_reference."), {
      status: 404,
    });
  }
  if (want === "client" && hasRef) {
    throw Object.assign(new Error("Unexpected body field: agent_reference."), { status: 400 });
  }
}

/**
 * A scripted stand-in for the Foundry Responses API.
 *
 * It mimics the shapes the harness actually branches on — streamed
 * `response.output_text.delta` events, a `function_call` output item, an
 * `mcp_approval_request`, and a final round with no tool calls — so the tool
 * loop, the approval gate and the SSE contract can be exercised end to end
 * without an Azure project. It is not a simulator: it does not reason, and the
 * replies are canned.
 */

interface MockItem {
  type: string;
  [k: string]: unknown;
}

interface Script {
  text: string;
  output: MockItem[];
}

function sentenceFor(userText: string): Script[] {
  const t = userText.toLowerCase();

  // Asking about files exercises a safe, auto-approved local tool.
  if (/\b(list|ls|files|directory|dir|what'?s in)\b/.test(t)) {
    return [
      {
        text: "Let me look at the workspace.\n\n",
        output: [
          {
            type: "function_call",
            id: `fc_${randomUUID()}`,
            call_id: `call_${randomUUID()}`,
            name: "list_directory",
            arguments: JSON.stringify({ path: "." }),
          },
        ],
      },
      {
        text: "That's what the workspace root holds right now. Want me to open any of them?",
        output: [],
      },
    ];
  }

  // Asking to write exercises the approval prompt on a `caution` tool.
  if (/\b(write|create|save|note|draft)\b/.test(t)) {
    return [
      {
        text: "I'll write that to a file.\n\n",
        output: [
          {
            type: "function_call",
            id: `fc_${randomUUID()}`,
            call_id: `call_${randomUUID()}`,
            name: "write_file",
            arguments: JSON.stringify({
              path: "notes/from-the-agent.md",
              content:
                "# Written by the mock agent\n\nThis file came through the approval gate.\n",
            }),
          },
        ],
      },
      { text: "Done — the file is in your workspace.", output: [] },
    ];
  }

  // Mentioning MCP exercises the service-side approval path.
  if (/\bmcp\b/.test(t)) {
    return [
      {
        text: "That needs an MCP server, so you'll get an approval prompt first.\n\n",
        output: [
          {
            type: "mcp_approval_request",
            id: `mcpr_${randomUUID()}`,
            server_label: "api-specs",
            name: "search_repository",
            arguments: JSON.stringify({ query: "authentication" }),
          },
        ],
      },
      { text: "Handled. In a real project Foundry runs that call itself.", output: [] },
    ];
  }

  return [
    {
      text:
        "This is **mock mode** — no Azure project is attached, so I'm replying from a script " +
        "rather than from a model.\n\nTry one of these to exercise the harness:\n\n" +
        "- *“list the workspace”* → a safe tool that runs without a prompt\n" +
        "- *“write me a note”* → a tool call that pauses for your approval\n" +
        "- *“use an MCP tool”* → the service-side MCP approval path\n\n" +
        "Set `FOUNDRY_MOCK=false` and fill in your project endpoint to talk to the real agent.",
      output: [],
    },
  ];
}

/** Did the harness hand back a refusal rather than a result? */
function wasRefused(input: any[]): boolean {
  return input.some((item) => {
    if (item?.type === "mcp_approval_response") return item.approve === false;
    if (item?.type !== "function_call_output") return false;
    try {
      return JSON.parse(String(item.output))?.denied === true;
    } catch {
      return false;
    }
  });
}

const scripts = new Map<string, Script[]>();

/** call_ids each response handed out, so continuations can be validated. */
const issued = new Map<string, Set<string>>();

/**
 * Reject a continuation the way the service does.
 *
 * A real project answers a mismatched or missing tool output with
 * `400 No tool output found for function call call_…`. Enforcing the same
 * contract here means the harness cannot regress to sending the wrong id —
 * `call_id` and `id` are different fields on a function_call item and are
 * easy to confuse.
 */
function enforceToolOutputs(params: any): void {
  const prev = params?.previous_response_id;
  if (typeof prev !== "string") return;
  const expected = issued.get(prev);
  if (!expected || expected.size === 0) return;

  const input: any[] = Array.isArray(params?.input) ? params.input : [];
  const got = new Set<string>(
    input
      .filter((i: any) => i?.type === "function_call_output")
      .map((i: any) => String(i.call_id)),
  );

  for (const id of expected) {
    if (!got.has(id)) {
      throw Object.assign(new Error(`No tool output found for function call ${id}.`), {
        status: 400,
      });
    }
  }
  for (const id of got) {
    if (!expected.has(id)) {
      throw Object.assign(
        new Error(`Unexpected tool output for unknown function call ${id}.`),
        { status: 400 },
      );
    }
  }
}

async function* streamScript(script: Script, responseId: string): AsyncGenerator<unknown> {
  yield { type: "response.created", response: { id: responseId } };

  // Chunk on word boundaries so the UI's streaming path gets a realistic feed.
  const words = script.text.split(/(\s+)/);
  for (const w of words) {
    if (!w) continue;
    await new Promise((r) => setTimeout(r, 12));
    yield { type: "response.output_text.delta", delta: w };
  }
  yield { type: "response.output_text.done", text: script.text };
  yield {
    type: "response.completed",
    response: {
      id: responseId,
      output: script.output,
      usage: { input_tokens: 128, output_tokens: script.text.length >> 2, total_tokens: 240 },
    },
  };
}

export function createMockOpenAI(): any {
  return {
    conversations: {
      create: async () => ({ id: `conv_mock_${randomUUID().slice(0, 8)}` }),
      delete: async () => ({ deleted: true }),
      items: {
        create: async () => ({ ok: true }),
      },
    },
    responses: {
      /** Non-streaming — used by the agent-reference probe. */
      create: async (params: any) => {
        enforceRefMode(params);
        enforceToolOutputs(params);
        return {
          id: `resp_probe_${randomUUID().slice(0, 8)}`,
          output: [],
          output_text: "pong",
        };
      },
      stream: (params: any) => {
        enforceRefMode(params);
        enforceToolOutputs(params);
        const responseId = `resp_mock_${randomUUID().slice(0, 8)}`;

        // First round carries the user message; continuations carry tool output.
        const input = Array.isArray(params?.input) ? params.input : [];
        const userMessage = input.find((i: any) => i?.type === "message");
        const key = String(params?.previous_response_id ?? params?.conversation ?? "new");

        let queue: Script[];
        if (userMessage) {
          queue = sentenceFor(String(userMessage.content ?? ""));
        } else if (wasRefused(input)) {
          // A real model sees the refusal in the tool output and changes course.
          // The mock must do the same, or the demo misrepresents the harness.
          queue = [
            {
              text: "Understood — I've left it alone. Tell me if you'd rather I take a different approach.",
              output: [],
            },
          ];
        } else {
          queue = scripts.get(key) ?? [{ text: "All set.", output: [] }];
        }

        // Name the answering target so a model switch is visible in the demo.
        const who = params?.model ? `*(${params.model})* ` : "*(mock-agent)* ";
        const head = queue[0] ?? { text: "All set.", output: [] };
        const current: Script = userMessage ? { ...head, text: who + head.text } : head;
        const rest = queue.slice(1);
        if (rest.length) scripts.set(responseId, rest);

        // Remember what this response asks to be answered.
        const calls = new Set<string>(
          (current.output ?? [])
            .filter((o: MockItem) => o.type === "function_call")
            .map((o: MockItem) => String(o["call_id"])),
        );
        if (calls.size) issued.set(responseId, calls);

        const iterator = streamScript(current, responseId);
        let settled: any;

        return {
          [Symbol.asyncIterator]: async function* () {
            for await (const ev of iterator) {
              if ((ev as any)?.type === "response.completed") settled = (ev as any).response;
              yield ev;
            }
          },
          finalResponse: async () => settled,
        };
      },
    },
  };
}

/** A plausible project: one agent plus a few model deployments. */
export function mockTargets(): TargetOption[] {
  return [
    {
      id: "agent:mock-agent",
      kind: "agent",
      label: "mock-agent",
      detail: "gpt-4.1",
      isDefault: true,
      toolSource: "agent",
    },
    {
      id: "model:gpt-4.1",
      kind: "model",
      label: "gpt-4.1",
      detail: "OpenAI · gpt-4.1",
      isDefault: false,
      toolSource: "harness",
    },
    {
      id: "model:gpt-5-mini",
      kind: "model",
      label: "gpt-5-mini",
      detail: "OpenAI · gpt-5-mini",
      isDefault: false,
      toolSource: "harness",
    },
    {
      id: "model:claude-sonnet-4-5",
      kind: "model",
      label: "claude-sonnet-4-5",
      detail: "Anthropic · claude-sonnet-4-5",
      isDefault: false,
      toolSource: "harness",
    },
    {
      id: "model:llama-3.3-70b",
      kind: "model",
      label: "llama-3.3-70b",
      detail: "Meta · llama-3.3-70b",
      isDefault: false,
      toolSource: "harness",
    },
  ];
}

export function mockHealthDetail(): string {
  return "mock mode — no Azure project attached";
}
