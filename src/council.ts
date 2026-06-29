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

/**
 * Parse the trailing `CHANGED:`/`VERDICT:` lines an advisor emits in a
 * deliberation round. Takes the **last** occurrence of each, so an advisor that
 * *quotes* an earlier verdict (e.g. "you said VERDICT: CONSENSUS, but…") before
 * its own closing line is read by its real conclusion, not the quote.
 */
export function parseVerdict(text: string): Verdict {
  const verdicts = [...text.matchAll(/^[\s>*_-]*\**\s*VERDICT:\s*\**\s*(CONSENSUS|OPEN)\b/gim)];
  const lastVerdict = verdicts.at(-1);
  const kind = lastVerdict ? (lastVerdict[1]!.toUpperCase() === "CONSENSUS" ? "consensus" : "open") : null;
  const changes = [...text.matchAll(/^[\s>*_-]*\**\s*CHANGED:\s*\**\s*(YES|NO)\b/gim)];
  const lastChange = changes.at(-1);
  const changed = lastChange ? lastChange[1]!.toUpperCase() === "YES" : null;
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
 * Convergence is a council-wide claim, so it requires **full participation**: every
 * active advisor (`voices`, one entry per advisor, errored ones carrying empty text)
 * must have actually answered this round. If any advisor dropped, we keep going
 * rather than declare "all advisors agreed" when one never spoke — the earlier
 * version could settle (or stalemate) on a single voice. Convergence is the
 * advisors' own self-report, not a comparison of wording:
 *
 * - **settled** — all advisors answered and *every* verdict is CONSENSUS.
 * - **stalemate** — all advisors answered and *every* one reports `CHANGED: no`
 *   (no position moved this round).
 *
 * Anything else (a model that omits the lines, or a partial round) keeps the debate
 * going, which is the safe default; the round cap is the backstop.
 */
export function councilSettlement(round: number, voices: CouncilVoice[]): Settlement {
  const total = voices.length;
  const answered = voices.filter((v) => v.text.trim().length > 0).map((v) => parseVerdict(v.text));
  if (total === 0 || answered.length < total) return { done: false }; // need every advisor's voice
  if (answered.every((v) => v.kind === "consensus")) {
    return { done: true, kind: "settled", message: `✅ **Settled** — all ${total} advisors reached consensus after ${round} rounds.` };
  }
  if (answered.every((v) => v.changed === false)) {
    return { done: true, kind: "stalemate", message: `⚖️ **Stalemate** — no advisor's position moved in round ${round}.` };
  }
  return { done: false };
}
