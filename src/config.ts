import { resolve } from "node:path";

/** The three council members. The host (whichever is driving the MCP) is excluded. */
export type MemberId = "claude" | "codex" | "grok";

/** All member ids, in a stable order used for iteration and voice ordering. */
export const MEMBER_IDS: MemberId[] = ["codex", "grok", "claude"];

/**
 * One council member reachable over its own `codex-acp`-style ACP subprocess.
 *
 * Everything here is per-member so the same {@link AcpSession} machinery can drive
 * any member with member-correct command, env var, and error/login text.
 */
export interface MemberSpec {
  /** Stable id used for host exclusion and routing. */
  id: MemberId;
  /** Display name used in tool output, status, logs, and error text. */
  name: string;
  /** How the member names itself inside prompts (e.g. "GPT-5/Codex"). */
  promptName: string;
  /** Argv used to spawn this member's ACP server. */
  acpCommand: string[];
  /** Env var that overrides {@link acpCommand}, named verbatim in error/status text. */
  commandEnvName: string;
  /** How to recover from an auth/usage failure, shown in startup errors. */
  loginHint: string;
}

/**
 * Runtime configuration, all sourced from the environment so the server stays
 * a pure stdio process that an agent can launch with `claude mcp add` (or the
 * equivalent for Codex/Grok).
 *
 * The three `allow*` flags are the guardian-mode expansion switches, shared by
 * all members: every one defaults to `false`, so out of the box a member may
 * only read inside the workspace and nothing else.
 */
export interface Config {
  /** Claude (Anthropic) — a council member when some *other* agent is the host. */
  claude: MemberSpec;
  /** Codex (GPT-5.x) — a council member. */
  codex: MemberSpec;
  /** Grok (xAI) — a council member, strong at live web/X search. */
  grok: MemberSpec;
  /**
   * Member to exclude as the host, forced via `MAGI_COUNCIL_EXCLUDE` (startup
   * only). Wins over clientInfo detection; undefined falls back to detection.
   */
  excludeOverride?: MemberId;
  /** Absolute path members are scoped to; the base for every guardian check. */
  workspaceRoot: string;
  /** Expansion: let a member read files outside {@link Config.workspaceRoot}. */
  allowExternalReads: boolean;
  /** Expansion: let a member edit/delete/move files inside the workspace. */
  allowWrites: boolean;
  /** Expansion: let a member run shell commands. */
  allowCommands: boolean;
  /**
   * Idle timeout: abort a turn only after this many ms of *silence* (no text,
   * reasoning, or tool-call output from the member). The clock resets on every
   * chunk, so an actively-streaming turn is never cut off — it frees the
   * serialized queue only when the member has genuinely wedged. A per-call
   * `time` can override it.
   */
  turnTimeoutMs: number;
  /** Optional path to append a full per-turn JSONL debug log to. */
  logFile?: string;
}

function envBool(name: string): boolean {
  const v = process.env[name]?.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Build a {@link MemberSpec}, reading the launch command from `commandEnvName`
 * (the env var is the single source of truth — it's both the override key and
 * what error messages name, so the two can't drift). A value is split on
 * whitespace into argv, so it can't carry an argument containing spaces; for that
 * case override the spawn another way rather than quoting here.
 */
function memberSpec(
  id: MemberId,
  name: string,
  promptName: string,
  commandEnvName: string,
  fallback: string[],
  loginHint: string,
): MemberSpec {
  const raw = process.env[commandEnvName]?.trim();
  const acpCommand = raw && raw.length > 0 ? raw.split(/\s+/) : fallback;
  return { id, name, promptName, acpCommand, commandEnvName, loginHint };
}

/** Parse `MAGI_COUNCIL_EXCLUDE` into a member id, ignoring anything unrecognized. */
function excludeOverride(): MemberId | undefined {
  const v = process.env.MAGI_COUNCIL_EXCLUDE?.trim().toLowerCase();
  return v && (MEMBER_IDS as string[]).includes(v) ? (v as MemberId) : undefined;
}

/** Build the {@link Config} from environment variables. */
export function loadConfig(): Config {
  return {
    claude: memberSpec(
      "claude",
      "Claude",
      "Claude",
      "MAGI_COUNCIL_CLAUDE_ACP_COMMAND",
      ["bunx", "@agentclientprotocol/claude-agent-acp"],
      "ensure Claude is authenticated (claude-agent-acp uses your Claude login or ANTHROPIC_API_KEY)",
    ),
    codex: memberSpec(
      "codex",
      "Codex",
      "GPT-5/Codex",
      "MAGI_COUNCIL_CODEX_ACP_COMMAND",
      ["bunx", "@agentclientprotocol/codex-acp"],
      "run `/codex:setup` or `codex login`",
    ),
    grok: memberSpec(
      "grok",
      "Grok",
      "Grok",
      "MAGI_COUNCIL_GROK_ACP_COMMAND",
      ["grok", "agent", "stdio"],
      "run `grok login` (Grok needs an xAI login with available usage)",
    ),
    excludeOverride: excludeOverride(),
    workspaceRoot: resolve(process.env.MAGI_COUNCIL_WORKSPACE ?? process.cwd()),
    allowExternalReads: envBool("MAGI_COUNCIL_ALLOW_EXTERNAL_READS"),
    allowWrites: envBool("MAGI_COUNCIL_ALLOW_WRITES"),
    allowCommands: envBool("MAGI_COUNCIL_ALLOW_COMMANDS"),
    turnTimeoutMs: envInt("MAGI_COUNCIL_TURN_TIMEOUT_MS", 600_000),
    logFile: process.env.MAGI_COUNCIL_LOG?.trim() || undefined,
  };
}
