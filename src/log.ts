import { appendFileSync } from "node:fs";
import type { Config } from "./config.ts";

/** One turn's full detail, kept out of the tool result and sent here instead. */
export interface TurnRecord {
  /** Which tool drove the turn (consult, reply, …). */
  tool: string;
  /** Wall-clock duration of the turn in ms. */
  ms: number;
  /** ACP stop reason (or `timeout`/`cancelled`). */
  stopReason: string;
  /** Total tokens for the turn, when Codex reported usage. */
  totalTokens?: number;
  /** Every guardian decision and tool call observed during the turn. */
  activity: string[];
  /** Codex's final text (only persisted to the file sink). */
  text: string;
}

/**
 * Record a finished turn for debugging. The tool result stays focused on
 * Codex's answer; the full play-by-play lands here instead: a one-line summary
 * to stderr always (captured in Claude Code's MCP logs), and the complete
 * record as JSONL to {@link Config.logFile} when configured.
 */
export function logTurn(config: Config, rec: TurnRecord): void {
  const blocked = rec.activity.filter((a) => a.startsWith("denied")).length;
  const summary =
    `[codex-fusion] ${rec.tool} ${(rec.ms / 1000).toFixed(1)}s stop=${rec.stopReason}` +
    (rec.totalTokens ? ` tok=${rec.totalTokens}` : "") +
    (blocked ? ` blocked=${blocked}` : "");
  process.stderr.write(`${summary}\n`);

  if (config.logFile) {
    try {
      appendFileSync(config.logFile, `${JSON.stringify({ at: new Date().toISOString(), ...rec })}\n`);
    } catch (err) {
      process.stderr.write(`[codex-fusion] log write failed: ${(err as Error).message}\n`);
    }
  }
}
