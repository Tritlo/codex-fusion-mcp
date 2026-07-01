# 0016 — Host-mediated deliberation (remove autonomous rounds)

**Context.** ADR 0008/0010 gave `consult` an **autonomous** multi-round mode: `rounds`
> 1 ran N rounds *inside one tool call*, the advisors rebutting each other, with a
self-reported `CHANGED:`/`VERDICT:` settlement detector (`councilSettlement`,
`parseVerdict`) and `until_settled` early-stop. The host was **excluded** from its own
council (ADR 0007) and only saw the finished result — it never participated in the
deliberation.

That's the wrong shape. The host *is* the most capable participant, and burying the
rounds inside one atomic call keeps it out of the loop. The fix isn't to spawn a sibling
host instance (considered and cut, ADR 0015) — it's to let the **host drive the rounds**.

**Decision.** Deliberation is **host-mediated**:

- `consult` runs **exactly one round** — every selected advisor answers independently
  (concurrently) — and returns, with a closing instruction telling the host to form its
  own position and **call `consult` again** (with an updated `my_take`) to run the next
  round. The advisors keep their context (persistent sessions) and respond to the host's
  evolving position. The host iterates until it judges agreement is reached.
- **Removed**: the `rounds` and `until_settled` params, the autonomous multi-round loop
  in `runMagi`, `magiDeliberatePrompt`, and `councilSettlement`/`parseVerdict` (+ their
  tests). `council.ts` keeps only `selectCouncil`.

**Why.** The host is a real participant now — it contributes a position every round and
decides when the council has converged — without spawning anything or relying on a
brittle string-matched settlement signal. One model, less machinery: a single fan-out
plus an instruction replaces the deliberation engine. (Supersedes the multi-round parts
of ADR 0008 and ADR 0010; their lifecycle/concurrency fixes stand.)

**Consequences.** Cross-pollination between advisors now flows *through the host* (it
synthesizes and feeds positions back via `my_take`) rather than advisor-to-advisor
inside one call — which is the point, but means the host must actually do the
re-calling. `fresh` makes each call independent, so it opts out of accumulating the loop.
A lone-advisor `consult` is fine (one read-only opinion; the host still drives any
iteration). Verified live: `consult` returns one round + the iterate instruction;
`rounds`/`until_settled` are gone from the schema.
