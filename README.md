# Foundry Desk

A Claude Desktop-like harness for an agent you host in **Microsoft Foundry** (Azure AI Foundry).

Foundry runs the agent. This runs everything around it: the chat window, the
conversation list, streaming output, local tool execution, and an approval
prompt in front of every tool call that touches your machine.

```
┌──────────────────────────────────────────────┐
│  web/   React UI — thread, tool cards,        │
│         approval prompts, conversation list   │
└───────────────┬──────────────────────────────┘
                │  SSE: normalized harness events
                │  POST /api/approvals/:id
┌───────────────▼──────────────────────────────┐
│  server/   THE HARNESS                        │
│    · holds the Azure credential               │
│    · owns the tool registry + workspace jail  │
│    · gates every tool call on your approval   │
│    · runs the tool loop, chains continuations │
└───────────────┬──────────────────────────────┘
                │  Responses API + agent_reference
┌───────────────▼──────────────────────────────┐
│  Microsoft Foundry Agent Service              │
│    · the agent, its model and instructions    │
│    · service-side tools: MCP, OpenAPI,        │
│      code interpreter, file search            │
└──────────────────────────────────────────────┘
```

The browser never talks to Foundry and never sees a credential.

## Which Foundry this targets

The **current** Foundry Agent Service, not Agents (classic). The two are
different protocols, and the classic one retires 31 March 2027.

| | classic | current (this project) |
|---|---|---|
| protocol | threads / runs / `submit_tool_outputs` | OpenAI **Responses** + `agent_reference` |
| state | threads | conversations |
| tool pause | run status `requires_action` | `function_call` / `mcp_approval_request` output items |
| JS package | `@azure/ai-projects` 1.x | `@azure/ai-projects` 2.x |

Built against `@azure/ai-projects` 2.8.0 and `openai` 7.33.0.

## Quick start

### 1. See it work with no Azure setup

```bash
npm install
npm run build
FOUNDRY_MOCK=true npm start --workspace server
# → http://localhost:4300
```

Mock mode swaps in a scripted agent, so the UI, the tool loop and the approval
gate all run with no project, no credential and no network. Try:

- *"list the workspace"* — a safe tool that runs without a prompt
- *"write me a note"* — pauses for your approval
- *"use an MCP tool"* — the service-side MCP approval path

### 2. Point it at your real agent

```bash
cp .env.example .env     # fill in endpoint + agent name
az login                 # DefaultAzureCredential picks this up
npm run dev              # server :4300, UI :5273 with hot reload
```

You need:

- `FOUNDRY_PROJECT_ENDPOINT` — Foundry portal → your project → Overview.
  Looks like `https://<account>.services.ai.azure.com/api/projects/<project>`.
- `FOUNDRY_AGENT_NAME` — Foundry agents are addressed by **name**; versions
  live under that name.
- An Entra ID identity with the **Azure AI User** role on the project.

## Choosing a model

The picker in the title bar lists two kinds of target, and the difference is
not cosmetic:

| | **Agents** | **Model deployments** |
|---|---|---|
| what it is | an agent you built in Foundry | any model deployed in the project |
| model | pinned by the agent version | the deployment itself |
| instructions | the agent's | `MODEL_INSTRUCTIONS` |
| tools | declared on the agent version | **sent inline by the harness** |

That last row is the useful part. A bare model deployment has nothing
server-side carrying your tools — so the harness sends its own instructions and
tool schemas on every call. **Local tools therefore work with any model in your
project without creating an agent version for it.** Switching from your agent to
`claude-sonnet-4-5` to compare behaviour is a dropdown, not a deployment.

Both listings come from the project itself (`project.deployments.list()` and
the agents listing), so the picker reflects whatever you actually have. If your
identity cannot enumerate agents, the configured one is still offered — a
missing permission degrades the picker rather than breaking the app.

Each conversation remembers what it was last addressed to, so reopening an old
thread does not silently switch model, and every answer is labelled with the
target that produced it.

## The thing that actually matters: who runs the tools

Foundry can run tools itself. A desktop harness exists to run the ones it
can't — the ones that touch your filesystem. Three cases, handled differently:

| | runs where | harness does |
|---|---|---|
| `function` tools | **here** | executes them, returns `function_call_output` |
| `function` tools, model target | **here** | same, with the schemas sent inline |
| MCP tools | Foundry | surfaces `mcp_approval_request`, returns your decision |
| code interpreter, file search, OpenAPI | Foundry | displays them for visibility |

**In agent mode, the model can only call local tools the agent version
declares.** If you curate tools in the portal, add matching function-tool
schemas there. To push this harness's schemas up instead, set
`FOUNDRY_SYNC_TOOLS=true` — it creates a new agent version on boot, which is
why it is off by default. Model-deployment targets never need any of this:
their tools go out inline on every call.

## Approvals

Every tool carries a risk tier. Tiers listed in `AUTO_APPROVE` run silently;
everything else stops and waits for you.

| tier | tools | default |
|---|---|---|
| `safe` | `read_file`, `list_directory` | auto-approved |
| `caution` | `write_file`, `fetch_url` | prompts |
| `dangerous` | `run_command` | prompts, and off unless `ENABLE_SHELL=true` |

You get **Allow once**, **Allow for session** (that tool, until the UI reloads)
and **Deny**. A denial is reported back to the model as the tool result, so it
knows it was refused and can adapt rather than silently retrying. An unanswered
prompt times out and **denies** — closing the tab can't leave a call approved.

MCP calls are never auto-approved, whatever their tier: they run with the
service's credentials against a remote server.

## Workspace confinement

Filesystem tools are hard-confined to `WORKSPACE_ROOT`. The check runs against
the *real* location of a path with symlinks resolved, so a link planted inside
the workspace is not a way out, and a path that doesn't exist yet is held to
the same boundary as one that does. `scripts/test-containment.mjs` covers
traversal, absolute paths, symlinks to files and directories outside, writes
through an escaping symlink, and dangling symlinks.

It is a check-then-use, so a symlink swapped between the check and the open
would defeat it. Closing that needs `openat2`/`O_NOFOLLOW`, which Node doesn't
expose. Fine for a single-user desktop harness; not fine for a shared service.

`run_command` uses `execFile`, never a shell, and only runs binaries in
`SHELL_ALLOWLIST`.

## Adding a tool

One object in `server/src/tools.ts`:

```ts
const grepWorkspace: ToolDef = {
  name: "grep_workspace",
  description: "Search the workspace for a regular expression.",
  risk: "safe",
  parameters: {
    type: "object",
    properties: { pattern: { type: "string" } },
    required: ["pattern"],
    additionalProperties: false,
  },
  preview: (a) => `grep ${a?.pattern}`,     // the line shown in the prompt
  run: async (a) => { /* … */ },
};
```

Add it to the `all` array. Re-publish the schemas to your agent
(`FOUNDRY_SYNC_TOOLS=true`) or add a matching tool in the portal, or the model
will never call it.

## Scripts

| | |
|---|---|
| `npm run dev` | server + UI, both watching |
| `npm run build` | typecheck and build both |
| `npm start --workspace server` | serve the built UI from the server |
| `node scripts/doctor.mjs` | check a **real** Foundry connection; prints a paste-safe report |
| `node scripts/smoke.mjs` | end-to-end: streaming, approve, deny, MCP, persistence |
| `node scripts/test-containment.mjs` | the workspace boundary, on its own |

`smoke.mjs` and `test-containment.mjs` expect mock mode — `smoke.mjs` needs a
running server (`SMOKE_BASE` to point elsewhere), `test-containment.mjs` needs
`npm run build --workspace server` first.

`doctor.mjs` is the opposite: point it at a real project. It checks the
endpoint shape, host reachability, the credential chain, whether your agent
declares any function tools, and a live conversation round trip. It prints no
tokens and redacts the hostname, so the output is safe to share when something
needs debugging.

## Branding

Themed for Aurora Technical Services. The palette comes from the company's own
brand reference — sampled from the logo artwork and deck template — not invented
here.

| | light | dark |
|---|---|---|
| background | `#FFFFFF` | `#242829` |
| sidebar | `#F4F5F5` | `#1F2223` |
| body text | `#1F2223` | `#E6E8E9` |
| secondary | `#54585A` Aurora Gray | `#A8A9AD` |
| faint | `#888B8D` Panel Gray | `#888B8D` |
| accent | `#C90000` | `#E8757E` |

Two decisions worth not undoing by accident:

**The accent changes between modes on purpose.** `#C90000` reaches 6.0:1 on
white, but only 2.0–2.7:1 on any of the dark grays considered — well under the
4.5:1 needed for text, borders or a focus ring. Dark mode uses `#E8757E`, the
tint already in Aurora's template palette (`accent6`), which reaches 5.2:1.
Every foreground/background pair in both themes meets WCAG AA or better.

**The logo sits on a white plaque in both modes.** Aurora's rule is that the
logo goes on white, never on red and never on a busy background, and its
wordmark is gray — it would all but disappear on the dark sidebar. The plaque
also provides the required clear space.

**Typography is Neue Kabel throughout** — headings, body, UI, the lot — with
Arial as the fallback, per the brand reference. Two caveats:

- Neue Kabel is a licensed Monotype face. It renders only on machines where it
  is installed; everywhere else the browser silently falls back to Arial. To
  guarantee it for everyone, self-host a `.woff2` and add an `@font-face` — but
  that needs a Monotype **webfont** licence, which is separate from the desktop
  one you already have.
- Code keeps a monospace stack: file paths, JSON tool arguments and directory
  listings stop being scannable in a proportional face. If you want those in
  Neue Kabel too, point `--mono` at `var(--sans)` in `web/src/styles.css`.

Note: the brand's red, sampled from the logo, is `#D2202F`. This theme uses
`#C90000` as specified. If you want the exact brand value instead, it is one
token — `--accent` in `web/src/styles.css`.

## Making it a desktop app

It is a local server plus a static UI, which is the shape Tauri and Electron
want. Wrap `server/` as the sidecar process and point the window at it; nothing
in the UI assumes a browser. That is the natural next step and is deliberately
not done here — it adds a toolchain without changing the architecture.

## What is and isn't verified

Verified, by running it:

- the full tool loop — stream, pause, approve, execute, resubmit, stream again
- model switching — target listing, switching mid-conversation, per-conversation
  pinning, per-answer attribution, and a tool call executing under a bare model
- approve / deny / session-grant, and timeout-denies
- the MCP approval path
- workspace confinement, including symlink escapes
- the UI in Chromium, light and dark, no console errors
- conversation persistence and transcript rehydration

**Not** verified: a live Microsoft Foundry project. No Azure credential was
available, so every run above used mock mode. The Foundry call shapes come from
the `@azure/ai-projects` 2.8.0 README and its `agentFunctionTool.ts`,
`agentMcp.ts` and `responseStream.ts` samples. Expect to adjust `foundry.ts`
when you first connect — that file exists to be the only place you'd need to.

One known ambiguity it already absorbs: the Azure samples disagree on how to
attach the agent reference. `agentFunctionTool.ts` binds it to the client;
`agentMcp.ts` sends `body: { agent_reference: … }`; the README shows
`body: { agent: … }`. Client binding is the default and sidesteps it;
`FOUNDRY_AGENT_REF_MODE=body` switches if your project needs it.
