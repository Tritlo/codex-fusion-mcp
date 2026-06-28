# 0007 — Symmetric council: Claude as a member, host auto-excluded

**Context.** ADR 0006 made the council Codex + Grok with Claude as the implicit
lead. But the machinery (`AcpSession`) is member-agnostic, and the same server is
useful to *any* frontier agent — Codex or Grok should be able to convene the other
two. We wanted: (1) Claude as a real third member, reachable as an ACP server via
[`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp);
(2) on `initialize`, detect which agent is the host and remove it from its own
council; (3) so other agents get the council just by registering the MCP server.

**Decision.**

- **Three members, host excluded.** Config grows a `claude` `MemberSpec`
  (`bunx @agentclientprotocol/claude-agent-acp`) alongside codex/grok; each carries
  a stable `id`. The MCP client's identity is the host and is excluded from the
  council, leaving the other two as advisors. Members are lazy, so the excluded
  one is never spawned (in the common Claude-host case, the Claude member never
  runs).

- **Host resolution.** Order: `MAGI_COUNCIL_EXCLUDE` (startup, explicit) >
  `clientInfo.name` regex (`claude`/`codex`/`grok`) > **unknown → exclude nobody**
  (all three participate; one may be the host). The resolution `source`
  (`env`/`clientInfo`/`unknown`) is surfaced in `status` and prepended as a warning
  by `ask_magi` when it's `unknown`, so an unrecognized host knows it can set the
  env var to exclude itself. (Codex argued for fail-closed to protect the "host gets
  the other two" invariant; we instead let all three in when unrecognized — simpler
  and the host can self-exclude — and rely on the runtime guards below.)

- **Two enforcement layers.** `oninitialized` resolves the host and `.remove()`s
  its tools (UX: a compliant client never lists them). Every direct-tool handler
  also calls an `isActive(member)` guard before spawning, and `ask_magi`/`permit`/
  `status` derive from the active set — so a client that cached tool names or
  ignored `tools/list_changed` still can't make the host advise itself. (`reset` is
  deliberately global — it clears *all* member sessions, including an excluded host's
  if one ever spawned.)

- **Host-neutral prompts.** Every prompt builder takes a `host` name; the preamble,
  debate frame, and magi framing address the real host, and `<claude_position>`
  became `<host_position>`. The permit log records "by host", not "by claude".
  "Claude" survives only as the Claude member's own identity.

- **Equal-advisor magi.** The council is the non-host members, and they are
  *equal* — every active advisor answers the same question independently, in member
  order, and the host synthesizes. This drops ADR 0006's "Codex primary, Grok
  metered/selective" special-casing (Grok is just another advisor now; it still
  leans on its built-in web/X search in-council). The old `grok` angle and
  `FOR GROK:` relay are gone.

**Consequences.** A member's direct tools appear only when it isn't the host
(`ask_claude`/`claude_reply` are new, and hidden in the usual Claude-host case).
Other agents get the council by registering the server — set `MAGI_COUNCIL_EXCLUDE`
explicitly for non-Claude hosts since detection isn't guaranteed (otherwise an
unrecognized host gets all three, including itself). The Claude member is
**experimental**: spawning `claude-agent-acp` from another agent is untested for
auth/recursion (passing `mcpServers: []` to its session blocks the nest-this-server
path), so it's easy to disable via `MAGI_COUNCIL_CLAUDE_ACP_COMMAND`. `/clear`
auto-reset is Claude Code-specific; Codex/Grok hosts use the manual `reset` tool.
