# 0012 — Round-2 hardening: honest quorum, decoupled startup, safe concurrency

**Context.** A second recursive self-review (Codex + Grok, read-only) regression-checked
round 1 (ADRs 0009–0011) and found real defects in the freshly-shipped code. Each was
verified against the source (and the test flake reproduced) before fixing.

**Decisions.**

- **Settlement requires a quorum.** `councilSettlement` (`src/council.ts`) declared
  *"all advisors reached consensus"* when only one of several actually answered (the
  others errored) — and a round-1 test codified that lie. It now requires **full
  participation**: settled/stalemate only when *every* active advisor answered this
  round; otherwise keep deliberating (the round cap is the backstop).

- **Startup timeout decoupled from the per-call idle window.** `ensureStartedAbortable`
  bounded *subprocess startup* by the per-call idle `time` override, so a small idle
  window (or a loaded box) could time out a cold `bunx` launch — and was the root cause
  of the flaky test net. Startup now always uses `config.turnTimeoutMs`; the per-call
  `time` only bounds *silence during a turn*, as documented.

- **One shared progress counter per tool call.** The round-1 parallel council gave each
  advisor its own `streamHooks` counter, so concurrent advisors emitted duplicate /
  out-of-order `progress` values on the one MCP progressToken. Split out
  `progressNotifier(extra)` — a single monotonic channel — shared across all advisors
  in a `consult`.

- **Guardian symlink containment.** Round 1 realpath'd only the client `fs/read_text_file`
  path; a member's *own* tool-call read/write of an in-workspace symlink to outside was
  still lexically "inside". The shell now resolves symlinks in the requested locations
  (`realPathBestEffort`, tolerant of not-yet-existing write targets) before the pure
  `guardianDecision` sees them. Policy stays pure; the shell does the fs work.

- **`parseVerdict` reads the last verdict**, not the first — an advisor quoting an earlier
  `VERDICT: CONSENSUS` before its own closing `VERDICT: OPEN` is no longer misread.

- **Stale-startup guard.** `ensureStarted`'s catch only clears `this.starting` if it's
  still the promise it awaited, so a superseded startup rejecting late can't null a newer
  `start()` and spawn two children.

- **`dispose()` hard-stops** (SIGTERM→SIGKILL via the shared `hardKill`), so an ephemeral
  `fresh` member or one alive at shutdown can't survive as an orphan.

- **Harness hardened + de-flaked.** New fake scenarios (`permission-always-only`,
  `answer-and-exit`); tests for quorum, last-verdict, the `allow_always` note, and
  post-success exit. The flake was purely the default 5s per-test budget vs two cold
  subprocess spawns under load — multi-spawn/timing tests get generous per-test timeouts;
  assertions stay strict. 19 tests, green across repeated loaded runs.

**Why.** These are correctness/honesty fixes to round-1 code, plus the test net itself —
the net has to be trustworthy before it can guard anything. The architecture shape
(imperative `AcpSession` shell + pure `council.ts` core + read-only council) was confirmed
right by both advisors; the slop they flagged (god-file `index.ts`) is addressed
separately.

**Consequences.** Settlement is stricter: a permanently-down advisor means a multi-round
`consult` runs to its cap and reports cap-reached rather than settling — honest, but more
rounds. `realPathBestEffort` adds a few `fs` calls per guarded tool-call (negligible).
