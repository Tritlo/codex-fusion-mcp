import { resolve } from "node:path";

/** One advisory agent Claude can consult. */
export interface CouncilMemberConfig {
  /** Stable id used in MCP inputs, env vars, logs, and status. */
  name: string;
  /** Human-readable name used in prompts and status. */
  displayName: string;
  /** Argv used to spawn this member's ACP server. */
  acpCommand: string[];
  /** Preferred ACP auth method ids, tried before generic non-interactive picks. */
  authMethods: string[];
  /** Short operator hint for auth/startup failures. */
  authHint: string;
}

/**
 * Runtime configuration, all sourced from the environment so the server stays
 * a pure stdio process that Claude Code can launch with `claude mcp add`.
 *
 * The three `allow*` flags are the guardian-mode expansion switches: every one
 * defaults to `false`, so out of the box members may only read inside the
 * workspace and nothing else.
 */
export interface Config {
  /** Advisory agents available to the MCP caller. */
  members: CouncilMemberConfig[];
  /** Head of the council; tools consult this member unless another is explicit. */
  headMember: string;
  /** Absolute workspace path each member is scoped to; the base for every guardian check. */
  workspaceRoot: string;
  /** Expansion: let members read files outside {@link Config.workspaceRoot}. */
  allowExternalReads: boolean;
  /** Expansion: let members edit/delete/move files inside the workspace. */
  allowWrites: boolean;
  /** Expansion: let members run shell commands. */
  allowCommands: boolean;
  /**
   * Idle timeout: abort a turn only after this many ms of *silence* (no text,
   * reasoning, or tool-call output from the member). The clock resets on every chunk,
   * so an actively-streaming turn is never cut off — it frees the serialized
   * queue only when a member has genuinely wedged. A per-call `time` can override it.
   */
  turnTimeoutMs: number;
  /** Optional path to append a full per-turn JSONL debug log to. */
  logFile?: string;
}

const BUILTIN_MEMBERS: Record<string, Omit<CouncilMemberConfig, "name">> = {
  codex: {
    displayName: "GPT-5/Codex",
    acpCommand: ["bunx", "@agentclientprotocol/codex-acp"],
    authMethods: [],
    authHint: "run `/codex:setup` or `codex login`, or set `OPENAI_API_KEY`",
  },
  gemini: {
    displayName: "Gemini CLI",
    acpCommand: ["gemini", "--acp"],
    authMethods: [],
    authHint: "run `gemini` once to sign in, or set `GEMINI_API_KEY`",
  },
  grok: {
    displayName: "Grok Build",
    acpCommand: ["grok", "agent", "stdio"],
    authMethods: ["xai.api_key", "cached_token"],
    authHint: "run `grok login`, or set `XAI_API_KEY`",
  },
};

function envBool(name: string): boolean {
  const v = process.env[name]?.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function envKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
}

function commandFrom(raw: string | undefined, fallback: string[]): string[] {
  return raw && raw.length > 0 ? raw.split(/\s+/) : fallback;
}

function loadMember(rawName: string): CouncilMemberConfig {
  const name = rawName.trim().toLowerCase();
  const key = envKey(name);
  const builtin = BUILTIN_MEMBERS[name];
  const commandEnv = process.env[`CODEX_FUSION_${key}_ACP_COMMAND`]?.trim();
  const legacyCommandEnv = name === "codex" ? process.env.CODEX_FUSION_ACP_COMMAND?.trim() : undefined;
  if (!builtin && !commandEnv) {
    throw new Error(
      `Unknown council member "${name}". Set CODEX_FUSION_${key}_ACP_COMMAND to provide its ACP command.`,
    );
  }
  const authMethodEnv = envList(`CODEX_FUSION_${key}_AUTH_METHODS`);
  return {
    name,
    displayName: process.env[`CODEX_FUSION_${key}_DISPLAY_NAME`]?.trim() || builtin?.displayName || name,
    acpCommand: commandFrom(commandEnv ?? legacyCommandEnv, builtin?.acpCommand ?? []),
    authMethods: authMethodEnv.length > 0 ? authMethodEnv : (builtin?.authMethods ?? []),
    authHint:
      process.env[`CODEX_FUSION_${key}_AUTH_HINT`]?.trim() ||
      builtin?.authHint ||
      `check authentication for ${name}`,
  };
}

function loadMembers(): CouncilMemberConfig[] {
  const names = envList("CODEX_FUSION_MEMBERS");
  const requested = names.length > 0 ? ["codex", ...names] : ["codex"];
  const seen = new Set<string>();
  return requested.flatMap((name) => {
    const normalized = name.trim().toLowerCase();
    if (seen.has(normalized)) return [];
    seen.add(normalized);
    return [loadMember(normalized)];
  });
}

/** Build the {@link Config} from environment variables. */
export function loadConfig(): Config {
  const members = loadMembers();
  return {
    members,
    headMember: "codex",
    workspaceRoot: resolve(process.env.CODEX_FUSION_WORKSPACE ?? process.cwd()),
    allowExternalReads: envBool("CODEX_FUSION_ALLOW_EXTERNAL_READS"),
    allowWrites: envBool("CODEX_FUSION_ALLOW_WRITES"),
    allowCommands: envBool("CODEX_FUSION_ALLOW_COMMANDS"),
    turnTimeoutMs: envInt("CODEX_FUSION_TURN_TIMEOUT_MS", 600_000),
    logFile: process.env.CODEX_FUSION_LOG?.trim() || undefined,
  };
}
