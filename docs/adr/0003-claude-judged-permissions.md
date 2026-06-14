# 0003 — Claude judges permissions (revises 0001)

**Context.** ADR 0001 had the MCP auto-resolve Codex's ACP permission requests
with a pure `guardianDecision` policy and no round-trip — deliberately keeping a
human out of the loop. That held up for reads/writes, but command execution
broke it: review genuinely needs `git diff`, yet `git` is an `execute` call, so
guardian blocked it. The attempted fix — a static read-only-command allowlist —
was empirically shredded in review (path-qualified programs like `./git`, RCE via
`git -c diff.external=…` / `--textconv`, mutating subcommands hiding under
"read-only" names, quote-bypass of the path-escape check). git's surface is too
large to allowlist safely.

**Decision.** Stop trying to encode command safety as a static policy. Keep "no
human round-trip" but make **Claude** the guardian instead of a fixed table:
when guardian doesn't auto-allow a request, the turn pauses and hands the request
back to the MCP caller (Claude) to allow or deny.

- **guardian → allow | ask.** `guardianDecision` now returns `allow` only for the
  cheap, clearly-safe cases (reads/searches inside the workspace) so Codex can
  explore without a round-trip per file; everything else (commands, writes,
  network, out-of-workspace reads) returns `ask`. The `ALLOW_*` flags downgrade a
  category from `ask` to auto-`allow`. The static allowlist is deleted.
- **Suspend/resume over MCP tool calls.** The ACP `requestPermission` handler,
  on `ask`, emits a permission onto an internal event channel and awaits a
  deferred. `ask()` returns a `TurnOutcome` of `permission` (the turn keeps
  running, suspended at the deferred). Claude calls the new `permit` tool, which
  resolves the deferred with the decision and drives the turn to its next pause
  or its answer. No MCP sampling/elicitation needed (Claude Code supports
  neither) — just ordinary tool calls.
- **Robustness folded in.** Stale-session guard: ACP callbacks ignore events
  whose `sessionId` isn't the current one (a respawned child can't bleed into a
  later turn). Abortable startup: a cancel during `initialize/newSession` kills
  the half-started child instead of pinning the queue. The per-segment timeout
  covers only Codex's active work — the wait for a `permit` decision is untimed —
  and a cancel/timeout hard-stops (cancel → grace → kill+respawn) so a
  cancel-ignoring agent can't wedge the queue. If Claude abandons a suspended
  turn and starts a new one, the stale turn is force-reset first.

**Consequences.** Codex can now run `git diff` (and anything else) — but each such
action is Claude's explicit call, visible and logged, rather than a guess by a
brittle table. The cost is extra round-trips: a turn that touches N
non-auto-allowed actions becomes N+1 tool calls (`consult` + N×`permit`). Reads
inside the workspace stay single-shot. Turns are still serialized; a suspended
turn holds the gate until it resumes or is abandoned. This trades the simplicity
of a one-shot tool for an interactive, judgeable loop — which is the point.
