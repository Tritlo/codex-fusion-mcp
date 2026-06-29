# 0014 — Simplification pass + concurrency hardening (council quality gate)

**Context.** A standing goal — *review and simplify; consult the council; fix what comes
up; repeat until all advisors agree it's stable and high-quality* — drove a multi-round
council quality gate (Codex + Grok, read-only). Each finding was verified against the code
(and reproduced) before acting; advisor claims that didn't hold up were discarded.

**Decisions / outcomes.**

- **Cut the experimental disagreement-matrix** (ADR 0013 → Parked). Unanimous top item: it
  duplicated the `runMagi` round loop, added a 4th `consult` flag, shipped without tests,
  and its scribe (`active[0]`) was the same advisor that then deliberated (framing bias).
  `consult` is back to three orthogonal flags: `rounds`, `until_settled`, `fresh`.

- **`index.ts` stays one cohesive deep module.** Extracting the *stateful* council
  orchestration (`runMagi`/`councilFanOut`/`councilTurn`) would force a 6–9-field
  deps object threaded through every call site or several shallow modules — trading a
  god-file for deps-threading slop. Against the deep-modules / explicit-over-clever /
  MVP values, the single file is the right shape. Both advisors agreed. (The pure logic
  already lives in `council.ts`; pure render/stream helpers *could* later peel into
  leaf modules at zero coupling cost — optional, not done.)

- **Concurrency hardening** — three real races, each found by Codex, verified, fixed, and
  covered by a test:
  1. **Queued-ask wedge.** A turn that would suspend on a permission while another `ask`
     is already waiting behind the gate now *abandons* instead of parking (`gateWaiters`),
     so the queued ask can't hang behind a turn that may never be permitted.
  2. **Abandoned-turn corruption.** That abandon path calls `reset()` (which kills the
     child), not `finish()` — otherwise the abandoned agent's late chunks bled into the
     queued turn's output.
  3. **Stale-child late messages.** `buildClient` binds each client to the child it serves
     (`isStale`) and rejects messages by *identity*, not just `sessionId`; `fake-acp` now
     mints unique session ids per `newSession` like real agents.

- **Shutdown hard-stop.** `dispose()` SIGKILLs immediately — the signal handlers
  `process.exit` right after, so the deferred SIGTERM→SIGKILL escalation could never fire.

- **Docs corrected** (full-participation settlement, concurrent fan-out, test timing).

- **Test coverage of `index.ts` wiring accepted as debt.** The high-risk parts — the pure
  convergence logic (`council.ts`) and the whole `AcpSession` lifecycle — are covered by 20
  deterministic tests; a seam for the orchestration would reintroduce the deps-threading we
  rejected.

**Outcome.** Both advisors reached **STABLE: YES** — no remaining real-agent must-fix
bug/race/leak. The goal is met.

**Consequences.** The matrix idea is parked in git (commit `9eba479`) if revived. The
concurrency invariants are now exercised by the fake-ACP harness. The deliberate choice to
*not* extract `index.ts` should be revisited only if it grows substantially beyond its
current cohesive scope.
