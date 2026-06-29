# 0013 — Targeted deliberation via a disagreement matrix (experimental)

**Status:** Experimental — opt-in via `consult { matrix: true }`.

**Context.** Multi-round `consult` (ADR 0008/0010) re-argues the *whole* question every
round: N advisors × R rounds of free-form rebuttal, most of it re-stating points already
agreed. Both round-2 self-reviews questioned whether the extra rounds earn their N× cost,
and Codex's bold idea was to *focus* re-deliberation on what's actually contested rather
than re-run everything.

**Decision.** Add an experimental `matrix` flag to `consult`:

1. **Openings** — every advisor answers independently (unchanged round 1).
2. **Scribe matrix** — the first active advisor acts as a neutral *scribe*
   (`disagreementMatrixPrompt`): it reads all openings and distils a markdown
   **disagreement matrix** (one row per genuinely contested claim, one column per
   advisor) plus the 1–3 most decision-relevant disagreements. It's surfaced to the host
   as its own block — a structured, reviewable record of where the council actually
   diverges.
3. **Targeted rounds** — each advisor re-deliberates **only the contested claims**
   (`targetedDeliberatePrompt` + the matrix), not the whole question, closing with the
   same `CHANGED:`/`VERDICT:` lines the existing `councilSettlement` reads. `rounds` caps
   the targeted rounds; `until_settled` still stops early on quorum consensus.

Implemented as a contained `runMatrixConsult` reusing `councilTurn`/`progressNotifier`/
`councilSettlement`; `fresh` and the ephemeral-session disposal still apply.

**Why.** The matrix makes the deliberation's *value* explicit (you can see what's disputed
before spending rounds on it) and concentrates the expensive rounds on disagreements — a
direct answer to "is multi-round worth it?". It reuses the existing settlement/streaming
machinery, so it's additive, not a fork of the core loop.

**Consequences.** One extra (scribe) turn per consult, and the scribe is a single advisor,
so the matrix carries that advisor's framing (a neutral-scribe prompt mitigates, doesn't
eliminate, this). The matrix is surfaced as text, not machine-parsed — deliberately, to
stay robust. Needs ≥2 advisors (falls back to the normal flow otherwise). Adds a 4th flag
to `consult` (`rounds`/`until_settled`/`fresh`/`matrix`) — the growing param surface is a
known tension flagged for the simplification pass. Not yet exercised by an automated test
(it's server-level orchestration; testing it cheaply needs the `index.ts` session-injection
refactor).
