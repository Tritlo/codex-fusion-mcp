# 0005 — Turn timeout is idle, not wall-clock

**Context.** ADR 0002 added a per-turn timeout so a wedged turn can't pin the
serialized queue, funnelling cancel and timeout into one `AbortController`. But it
was a **fixed wall-clock timer armed at the start of `drive()`** — it never
reset while Codex worked. The reasoning stream (ADR's heartbeat) resets the *MCP
client's* request timeout on each progress notification, but nothing reset the
*server's* timer. So a turn that streamed output continuously for longer than
`CODEX_FUSION_TURN_TIMEOUT_MS` (default 5 min) was still hard-stopped mid-stream,
and the user got a truncated answer. In practice big `review_diff`/`explore` turns
timed out "with partial results" precisely because they were busy the whole time —
the opposite of what a wedge-detector should fire on.

**Decision.** Make the turn timeout an **idle** timeout, measured from Codex's
last output.

- A `bumpIdle()` closure, set by the active `drive()` segment, is called from the
  `sessionUpdate` ACP callback on every **progress-bearing** update — text,
  reasoning, tool call / tool-call update, plan (`LIVENESS_UPDATES`). It pushes a
  `lastActivity` timestamp forward. Housekeeping updates (usage/mode/config/
  commands/session-info, the echoed user message) are deliberately *not* liveness,
  so they can't keep a genuinely wedged turn alive forever.
- The timer **re-arms** instead of firing: on expiry it checks `remaining =
  timeout − (now − lastActivity)`; if positive it reschedules for that window,
  otherwise it aborts (the same cancel → grace → hard-stop path as before). So an
  actively-streaming turn is never cut off, however long it runs; only genuine
  silence for the full window aborts. `now` is a **monotonic** clock
  (`performance.now()`), so a wall-clock jump (NTP, laptop/WSL2 suspend-resume)
  can't make the watchdog fire early and kill a live turn.
- `bumpIdle` is cleared in `clearSegment` under the existing `id === this.turnId`
  generation guard (alongside the `turnOn*` callbacks): a superseded segment must
  not clear the bumper out from under the newer turn that now owns it, which would
  silently revert the new turn to a wall-clock timeout.
- The default rose 5 min → **10 min** (`CODEX_FUSION_TURN_TIMEOUT_MS`), now read as
  "max silence", not "max work".
- A per-call **`time`** arg (seconds) on every long-running tool (and `permit`)
  overrides the window for one call — for a review/exploration expected to go quiet
  for a stretch (e.g. a slow allowed command) without lowering the bar for the rest.

Idle-reset over a larger fixed wall-clock cap because the failure we guard against
is a *wedge* (no progress), and "no output for N seconds" is the direct signal for
that; any fixed total budget either kills legitimate long work or waits pointlessly
on a hang. The startup path keeps a plain wall-clock timeout (no streaming to reset
on) but now honours the per-call `time` too.

**Consequences.** Long turns keep their partial output instead of losing it; the
timeout fires only on real silence. A turn stuck *inside* a single long tool call
(a hung allowed command that emits no further updates) still trips the idle window —
correct, that is a wedge. The footer's timeout hint now points at the `time` arg
rather than only the env var. ADR 0002's single-`AbortController` cancel/timeout
funnel and hard-stop semantics are unchanged; only *when* the timeout fires moved.
