/**
 * Pure helpers for council deliberation: parsing an advisor's verdict line and
 * deciding when a multi-round debate has converged. Kept side-effect-free and
 * separate from the MCP server so the convergence logic is unit-testable without
 * spawning anything (functional core, imperative shell).
 */

/** A parsed deliberation verdict: the CONSENSUS/OPEN line plus self-reported movement. */
export interface Verdict {
  /** The VERDICT line's kind, or null if the advisor produced none. */
  kind: "consensus" | "open" | null;
  /** Whether the advisor reported its position moved this round (CHANGED: yes/no), or null if absent. */
  changed: boolean | null;
}

/** Parse the trailing `CHANGED:`/`VERDICT:` lines an advisor emits in a deliberation round. */
export function parseVerdict(text: string): Verdict {
  const v = text.match(/^[\s>*_-]*\**\s*VERDICT:\s*\**\s*(CONSENSUS|OPEN)\b/im);
  const kind = v ? (v[1]!.toUpperCase() === "CONSENSUS" ? "consensus" : "open") : null;
  const c = text.match(/^[\s>*_-]*\**\s*CHANGED:\s*\**\s*(YES|NO)\b/im);
  const changed = c ? c[1]!.toUpperCase() === "YES" : null;
  return { kind, changed };
}

/** One advisor's answer in a round, as seen by the settlement check. */
export interface CouncilVoice {
  name: string;
  text: string;
}

/** Whether a round converged, and how to label it. */
export type Settlement = { done: false } | { done: true; kind: "settled" | "stalemate"; message: string };

/**
 * Decide whether a deliberation round has converged, from the advisors' verdicts.
 *
 * Only advisors that actually produced an answer are counted — an errored or empty
 * advisor never makes the council look settled *or* stalled (the prior string-compare
 * detector could be poisoned by repeated empty/error text). Convergence is the
 * advisors' own self-report, not a comparison of wording:
 *
 * - **settled** — at least one advisor answered and *every* answering advisor's
 *   verdict is CONSENSUS.
 * - **stalemate** — every answering advisor explicitly reports `CHANGED: no`, i.e.
 *   no one's position moved this round.
 *
 * Anything else (including a model that omits the lines) keeps the debate going,
 * which is the safe default.
 */
export function councilSettlement(round: number, voices: CouncilVoice[]): Settlement {
  const answered = voices.filter((v) => v.text.trim().length > 0).map((v) => parseVerdict(v.text));
  if (answered.length === 0) return { done: false };
  if (answered.every((v) => v.kind === "consensus")) {
    return { done: true, kind: "settled", message: `✅ **Settled** — all advisors reached consensus after ${round} rounds.` };
  }
  if (answered.every((v) => v.changed === false)) {
    return { done: true, kind: "stalemate", message: `⚖️ **Stalemate** — no advisor's position moved in round ${round}.` };
  }
  return { done: false };
}
