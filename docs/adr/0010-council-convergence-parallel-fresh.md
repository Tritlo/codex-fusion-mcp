# 0010 — Council: self-reported convergence, parallel advisors, fresh sessions

**Context.** ADR 0008 added multi-round deliberation with `until_settled`, detecting
convergence by string-comparing normalized `VERDICT:` lines across rounds
(`sameMultiset`) plus an "all CONSENSUS" check. The recursive self-review flagged
this as brittle, and the code confirmed it:

- An errored/empty advisor yields a `""` signature; two such rounds compare *equal*
  and trip a false **stalemate**, exactly when a member is down.
- "all CONSENSUS" only checked the verdict *kind*, so it could declare **settled**
  while the advisors' actual conclusions still differed.
- Advisors ran **sequentially** within every round and fan-out, so `consult`
  wall-time was the sum of advisor latencies.
- Persistent sessions mean council votes **carry context across calls**, weakening
  the anti-anchoring property — round-1 independence only helps *within* one call.

**Decision.**

- **Convergence is self-reported, not string-compared.** The deliberation prompt now
  ends with a `CHANGED: yes/no` line alongside `VERDICT: CONSENSUS/OPEN`. A new pure
  module [`src/council.ts`](../../src/council.ts) (`parseVerdict`,
  `councilSettlement`) decides: **settled** = every *answering* advisor reports
  CONSENSUS; **stalemate** = every answering advisor reports `CHANGED: no` (no one
  moved). Errored/empty advisors are excluded, and an all-empty round is never
  settled. Unit-tested in `test/council.test.ts` — no server or subprocess needed.

- **Advisors run concurrently.** `councilFanOut` and each deliberation round fan out
  with `Promise.all` over the active advisors (each already has its own
  session/gate), rendered back in member order. The council stays a single atomic
  tool call; this roughly halves `consult` wall-time for two advisors. A shared
  `councilTurn` helper produces both the rendered voice and the raw text the
  settlement check needs.

- **`fresh` consult.** `consult` gains a `fresh` flag: each advisor runs on a
  throwaway `AcpSession` (created once, reused across the consult's rounds, disposed
  in a `finally`), so votes neither carry nor leave cross-call context — genuine
  independence on demand. Default `false` keeps the persistent collaborator model.

**Why.** A self-reported "did your position move" is a more meaningful convergence
signal than wording equality, and counting only answers removes the poisoning.
Parallelism is free because the sessions are already independent. `fresh` is opt-in
so the cheap, context-carrying default is unchanged — it answers the "how much
should advisors remember across calls?" tension without forcing a side (see also the
proposed MAGI.md memory, ADR 0011).

**Consequences.** Settlement now depends on models emitting `CHANGED:`; one that
omits it simply keeps the debate going (safe). The stalemate label wording changed.
`fresh` spawns a subprocess per advisor per consult (startup cost) and forfeits
accumulated context. Parallel advisors' streaming progress is namespaced per voice
but now arrives interleaved rather than advisor-by-advisor.
