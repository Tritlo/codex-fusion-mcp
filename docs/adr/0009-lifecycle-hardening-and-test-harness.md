# 0009 — Lifecycle hardening + a deterministic ACP test harness

**Context.** After ADRs 0001–0008 the `AcpSession` state machine (spawn, serialized
turns, suspend/resume permits, idle timeout, cancel → hard-stop → respawn, `/clear`
nonce reset) is the most intricate and least-covered part of the project — it had
**zero tests**. A recursive self-review (the council reviewing itself: Codex + Grok,
read-only) independently ranked "test the state machine" highest and flagged a
handful of latent lifecycle gaps. Both findings were verified against the code
before acting.

**Decision.**

- **Settle held-open permissions on reset.** A suspended turn parks an ACP
  `requestPermission` promise (`session.ts` `requestPermission`). `reset()` killed
  the child and cleared `awaitingDecision` but never resolved that promise, leaving
  it dangling (only the child's death masked it). `PendingPermission` gains a
  `cancel()` that resolves the request as `cancelled`; `reset()` calls it before
  `forceReset()`.

- **Hard stop is actually hard.** `forceReset` sent only `SIGTERM`; an agent that
  ignores it could survive as an orphan despite the README's "hard-stopped and
  respawned" promise. It now escalates to `SIGKILL` after `HARD_STOP_GRACE_MS` (an
  `unref`'d timer, cleared on `exit`).

- **Unexpected child death wakes the active turn.** `child.on("exit")` now pushes a
  `failed` event when the death wasn't our own `forceReset` (distinguished by
  `this.child === child`, since our kill paths null `this.child` first). A crashed
  member fails fast instead of waiting out the whole idle timeout.

- **Symlink-safe reads.** `isReadable` compares `realpath(target)` against
  `realpath(workspaceRoot)`, so an in-workspace symlink can't point outside and
  escape the read sandbox served by `fs/read_text_file`.

- **`allow_always` footgun is surfaced.** `pickOption` still prefers `allow_once`,
  but when an agent offers *only* `allow_always`, a single host `permit allow` would
  silently become a standing grant. It now logs a host-visible note in that case.

- **Deterministic ACP test harness.** `test/fake-acp.ts` is a real ACP *agent*
  subprocess (`AgentSideConnection` over stdio), scripted by `--scenario`.
  `test/session.test.ts` drives `AcpSession` against it through the genuine
  spawn → initialize → newSession → prompt → permission → cancel path. Scenarios
  cover: happy turn (text + reasoning + usage), permit allow/deny, abandon a
  suspended turn, explicit reset, read-only council mode, idle timeout, external
  cancel, crash-fails-fast, gate serialization, and nonce reset. `bun test`, ~3s,
  no network, no real model calls.

**Why.** E2E against a fake agent tests the *protocol behavior* that is this
project's real risk surface, not prompt strings — and matches the preference for
fast, deterministic integration tests over unit tests. The harness uses only the
existing SDK + `bun:test`, no new dependency.

**Consequences.** The fake agent is a maintenance surface that must track ACP
changes. SIGKILL escalation is process-level, not process-group: a member that
spawns grandchildren could still orphan those (noted, not handled). `tsconfig`
still scopes `tsc` to `src/`; test files are type-stripped by Bun, not tsc-checked.
