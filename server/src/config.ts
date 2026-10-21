import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type { RiskTier } from "./protocol.js";

/**
 * Load .env from the repository root, not from the working directory.
 *
 * `npm start --workspace server` runs with cwd set to `server/`, so plain
 * `dotenv/config` would look for `server/.env` and silently miss the `.env` at
 * the root that the README tells you to create. Both are read — server-local
 * first so it can override — and real environment variables still win, since
 * dotenv never overwrites what is already set.
 */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(moduleDir, "..", "..");
for (const candidate of [
  path.join(repoRoot, "server", ".env"),
  path.join(repoRoot, ".env"),
]) {
  if (fs.existsSync(candidate)) dotenv.config({ path: candidate });
}

function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(
      `Missing required environment variable ${name}.\n` +
        `Copy .env.example to .env at the repository root and fill it in:\n` +
        `  cp ${path.join(repoRoot, ".env.example")} ${path.join(repoRoot, ".env")}\n` +
        `Or run in mock mode with no Azure project: FOUNDRY_MOCK=true`,
    );
  }
  return v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes";
}

function list(name: string, fallback: string[]): string[] {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Mock mode swaps the Foundry client for a scripted one, so the UI and the
 * whole tool/approval loop can be exercised with no Azure project, no
 * credential and no network. Nothing leaves the machine.
 */
const mock = bool("FOUNDRY_MOCK", false);

/**
 * Test fixture: in mock mode, make the fake project accept ONLY this agent
 * reference shape, so the auto-probe can be exercised without Azure.
 * Unset (the normal case) means the mock accepts anything.
 */
const mockRefMode = process.env["FOUNDRY_MOCK_REF_MODE"]?.trim().toLowerCase() || "";
if (mockRefMode && mockRefMode !== "client" && mockRefMode !== "body") {
  throw new Error(`FOUNDRY_MOCK_REF_MODE must be "client" or "body", got "${mockRefMode}".`);
}

function reqUnlessMock(name: string, mockValue: string): string {
  return mock ? (process.env[name]?.trim() || mockValue) : req(name);
}

const RISK_TIERS: RiskTier[] = ["safe", "caution", "dangerous"];

function riskTiers(name: string, fallback: RiskTier[]): RiskTier[] {
  const raw = list(name, fallback);
  const bad = raw.filter((r) => !RISK_TIERS.includes(r as RiskTier));
  if (bad.length) {
    throw new Error(
      `${name} contains unknown risk tier(s): ${bad.join(", ")}. Valid values: ${RISK_TIERS.join(", ")}.`,
    );
  }
  return raw as RiskTier[];
}

const workspaceRoot = path.resolve(process.env["WORKSPACE_ROOT"]?.trim() || "./workspace");
fs.mkdirSync(workspaceRoot, { recursive: true });

const dataDir = path.resolve(process.env["DATA_DIR"]?.trim() || "./data");
fs.mkdirSync(dataDir, { recursive: true });

const AGENT_REF_MODES = ["auto", "client", "body"] as const;
const agentRefModeRaw = (process.env["FOUNDRY_AGENT_REF_MODE"]?.trim() || "auto").toLowerCase();
if (!(AGENT_REF_MODES as readonly string[]).includes(agentRefModeRaw)) {
  throw new Error(
    `FOUNDRY_AGENT_REF_MODE must be one of ${AGENT_REF_MODES.join(", ")}, got "${agentRefModeRaw}".`,
  );
}

export const config = {
  port: Number(process.env["PORT"] ?? 4300),

  foundry: {
    mock,
    mockRefMode: mockRefMode as "" | "client" | "body",
    endpoint: reqUnlessMock("FOUNDRY_PROJECT_ENDPOINT", "mock://foundry-desk"),
    agentName: reqUnlessMock("FOUNDRY_AGENT_NAME", "mock-agent"),
    /** Optional: only needed to create agent versions or to call a bare model. */
    modelName: process.env["FOUNDRY_MODEL_NAME"]?.trim() || "",
    agentRefMode: agentRefModeRaw as "auto" | "client" | "body",
    syncTools: bool("FOUNDRY_SYNC_TOOLS", false),
    /**
     * System prompt used when a turn is addressed to a bare model deployment
     * rather than a hosted agent. An agent carries its own instructions, so
     * this is ignored in that case.
     */
    /**
     * Summarise the opening exchange into a short conversation title.
     * One small extra request per conversation, so it can be turned off.
     */
    titles: bool("FOUNDRY_TITLES", true),
    /**
     * Deployment used for that summary. A hosted agent is the wrong tool for
     * it — its instructions and tools apply to every call — so titling needs
     * a bare model. Falls back to FOUNDRY_MODEL_NAME.
     */
    titleModel:
      process.env["FOUNDRY_TITLE_MODEL"]?.trim() ||
      process.env["FOUNDRY_MODEL_NAME"]?.trim() ||
      "",
    modelInstructions:
      process.env["MODEL_INSTRUCTIONS"]?.trim() ||
      "You are a desktop assistant with access to the user's local workspace through " +
        "function tools. Prefer reading before writing, keep paths relative to the " +
        "workspace root, and explain what you are about to do when a change is destructive.",
  },

  /** Filesystem tools are hard-confined to this directory. */
  workspaceRoot,
  dataDir,

  approvals: {
    autoApprove: riskTiers("AUTO_APPROVE", ["safe"]),
    timeoutMs: Number(process.env["APPROVAL_TIMEOUT_SECONDS"] ?? 300) * 1000,
  },

  shell: {
    enabled: bool("ENABLE_SHELL", false),
    allowlist: list("SHELL_ALLOWLIST", ["git", "ls", "cat", "rg", "node", "npm", "python3"]),
  },
} as const;

export type Config = typeof config;
