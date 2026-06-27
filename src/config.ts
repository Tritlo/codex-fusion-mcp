import { resolve } from "node:path";

/**
 * Runtime configuration, all sourced from the environment so the server stays
 * a pure stdio process that Claude Code can launch with `claude mcp add`.
 *
 * The three `allow*` flags are the guardian-mode expansion switches: every one
 * defaults to `false`, so out of the box Codex may only read inside the
 * workspace and nothing else.
 */
export interface Config {
  /** Argv used to spawn the codex-acp ACP server. */
  acpCommand: string[];
  /** Absolute path Codex is scoped to; the base for every guardian check. */
  workspaceRoot: string;
  /** Expansion: let Codex read files outside {@link Config.workspaceRoot}. */
  allowExternalReads: boolean;
  /** Expansion: let Codex edit/delete/move files inside the workspace. */
  allowWrites: boolean;
  /** Expansion: let Codex run shell commands. */
  allowCommands: boolean;
  /**
   * Idle timeout: abort a turn only after this many ms of *silence* (no text,
   * reasoning, or tool-call output from Codex). The clock resets on every chunk,
   * so an actively-streaming turn is never cut off — it frees the serialized
   * queue only when Codex has genuinely wedged. A per-call `time` can override it.
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

/** Build the {@link Config} from environment variables. */
export function loadConfig(): Config {
  const raw = process.env.CODEX_FUSION_ACP_COMMAND?.trim();
  const acpCommand =
    raw && raw.length > 0 ? raw.split(/\s+/) : ["bunx", "@agentclientprotocol/codex-acp"];
  return {
    acpCommand,
    workspaceRoot: resolve(process.env.CODEX_FUSION_WORKSPACE ?? process.cwd()),
    allowExternalReads: envBool("CODEX_FUSION_ALLOW_EXTERNAL_READS"),
    allowWrites: envBool("CODEX_FUSION_ALLOW_WRITES"),
    allowCommands: envBool("CODEX_FUSION_ALLOW_COMMANDS"),
    turnTimeoutMs: envInt("CODEX_FUSION_TURN_TIMEOUT_MS", 600_000),
    logFile: process.env.CODEX_FUSION_LOG?.trim() || undefined,
  };
}
