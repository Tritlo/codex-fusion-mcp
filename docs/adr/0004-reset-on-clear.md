# 0004 — Reset Codex when the Claude session clears

**Context.** ADR 0001 keeps **one persistent Codex session per workspace** so
Codex accumulates context across calls — its main value. But the MCP stdio server
(and its `codex-acp` child) is spawned once and is **not** restarted when the user
runs `/clear` in Claude Code: `/clear` wipes Claude's history but leaves MCP
subprocesses alive. So the next conversation lands on a Codex that still remembers
the previous one — context bleed Claude can't even see, since its own memory of
that context is gone. We need to reset Codex's session when Claude's clears.

The hard constraint: **there is no MCP-protocol signal for `/clear`.** For stdio
transport `extra.sessionId` is undefined and `_meta` carries only a
`progressToken`; Claude Code threads no conversation id to the server. The server
cannot detect `/clear` on its own. The only reliable channel is a Claude Code
`SessionStart` hook, which receives `source ∈ {startup,resume,clear,compact}` and
the new `session_id`.

**Decision.** Add a reset capability with two triggers and one teardown.

- **One idempotent `reset()` primitive.** Extracted from the pre-gate
  abandon-a-suspended-turn block already in `ask()`: bump `turnId`, force-reset
  the child, clear `awaitingDecision`/event state, and release the gate **if
  held**. It must run *before* `acquireGate` — a suspended turn deliberately holds
  the gate (ADR 0003), so a reset that waited on the gate would deadlock. Both
  triggers below call this one method.
- **Automatic on `/clear`, via a hook + nonce file.** A `SessionStart` hook writes
  the new `session_id` to a per-workspace nonce file (path = hash of the workspace
  root, in the OS temp dir; the hook and server share one `resetNonceFile()` so it
  can't drift). The server reads the nonce at the top of `ask()` and `permit()`;
  if it differs from the baseline read at construction, it `reset()`s first. The
  hook acts only on `source == "clear"` — `compact`/`resume`/`startup` are left
  alone (compaction means to preserve continuity; the others coincide with a fresh
  server anyway). On a changed nonce, `permit()` resets and returns
  "no pending permission" rather than resuming a stale turn.
- **Manual `reset` tool.** Calls the same primitive. Covers context-window bloat on
  long sessions, switching to an unrelated task, recovering a confused Codex, and
  is the fallback when the hook isn't installed.

A `nonce` (the session id), not a counter: it needs only a plain atomic write
(temp + rename), avoids a read-modify-write race between windows, and "differs
from last-seen" naturally covers both `/clear` and resume. A missing/unreadable
file is treated as "no change", never reset churn.

**Consequences.** `/clear` now starts Codex fresh too, once the hook is installed
(documented in the README; without it, `reset` is the manual escape hatch).
Accepted v1 limits: (a) the nonce is keyed by workspace, so two Claude windows in
the *same* workspace share it — a `/clear` in one resets Codex for both; this only
discards advisory context, never corrupts it. Per-window isolation would need a
conversation id in `_meta`, which Claude Code doesn't send. (b) The reverse
asymmetry is inherent: Codex's context lives only as long as the server process
while Claude's is persisted, so after a resume/crash/reboot Codex starts empty
while Claude remembers — a `reply` may hit a Codex without the thread. Documented,
not engineered around. The persistent-session model of ADR 0001 stands; this is
its missing counterweight.
