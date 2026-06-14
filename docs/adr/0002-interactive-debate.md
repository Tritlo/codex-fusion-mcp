# 0002 — interactive debate, streaming, and focused output

**Context.** v0.1 made each consult a single opaque request/response: Claude
asked, Codex answered once, and the tool result was prefixed with the entire
guardian/tool play-by-play. Three gaps hurt the actual fusion workflow — the
synthesis step (where the value is) was a one-shot rather than a debate; long
turns ran blind and could wedge the serialized queue; and the result buried
Codex's answer under ACP bookkeeping. Several robustness bugs compounded this: a
failed startup poisoned the cached `starting` promise forever, a dead codex-acp
subprocess was never noticed, and there was no turn timeout.

**Decision.** Make the tool interactive and self-healing, without breaking the
single-persistent-session model.

- **Debate, Claude-driven.** The MCP server can't call Claude, so a tool-internal
  loop would just be Codex talking to itself. Instead the deliberative prompts
  gain a debate frame and must end each reply with `VERDICT: CONSENSUS — …` or
  `VERDICT: OPEN — …`. Claude reads the verdict and continues with a new `reply`
  tool — a plain turn on the same session — capped at ~3 exchanges. Convergence
  is machine-visible; the persistent session carries the thread.
- **Streaming + cancellation.** Each turn streams Codex's text and a `↳` activity
  trail as MCP progress notifications (`message` field), so the user can watch and
  steer between turns. The tool callback's `AbortSignal` (user cancel) and a
  `CODEX_FUSION_TURN_TIMEOUT_MS` timeout both funnel into one `AbortController`
  that issues an ACP `session/cancel`; a cancelled/timed-out turn returns
  gracefully instead of wedging the queue.
- **Focused output, debug log split out.** The tool result is now Codex's answer
  plus a one-line footer (latency · tokens · blocked count). The full per-turn
  detail (every guardian decision and tool call) moves to a debug sink: a terse
  stderr summary always, and full JSONL to `CODEX_FUSION_LOG` when set.
- **Robustness.** `ensureStarted` clears the `starting` promise on failure so a
  fixed login recovers without a restart; a `child.on("exit")` handler resets the
  session so the next call respawns; token usage from `PromptResponse.usage` is
  surfaced in the footer.
- **New tools.** `reply` (continue the debate) and `status` (read-only health:
  workspace, guardian flags, session/subprocess liveness, recent stderr).

**Consequences.** The fusion loop is now an actual back-and-forth that the user
can see, steer, and cancel, and that recovers from auth/subprocess failures
mid-session. Turns are still serialized on one session, so a debate is a
sequence of turns, not concurrent ones. The `VERDICT:` contract is a soft
convention Codex follows, not enforced parsing — Claude decides when consensus
is reached. No new dependencies.
