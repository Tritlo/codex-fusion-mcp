# 0006 — Add Grok as a second council member (the Magi)

> This change also renamed the project **codex-fusion-mcp → magi-council-mcp** —
> directory, package, MCP server name, and the env-var prefix
> **`CODEX_FUSION_*` → `MAGI_COUNCIL_*`**. Earlier ADRs predate the rename and use
> the old names.

**Context.** The project was single-member: one `CodexSession` over `codex-acp`,
and every tool talked to it. We wanted a second frontier model — **Grok** (xAI),
reachable as an ACP server via `grok agent stdio` (confirmed: protocol v1,
streams `agent_message_chunk`/`agent_thought_chunk`/`tool_call`, and its built-in
web/X search runs *without* an ACP permission round-trip). Two asks: a direct
endpoint for Grok, and a "council" where Claude, Codex, and Grok deliberate
together. Constraint: **Grok is metered** (no flat subscription), so it must never
be called automatically and the council must be frugal with it.

**Decision.**

- **Generalize, don't duplicate.** `CodexSession` → `AcpSession` (in
  `src/session.ts`), parameterized by a `MemberSpec { name, acpCommand,
  commandEnvName, loginHint }`. All the lifecycle work (persistent session,
  serialized turns, idle timeout, cancel/hard-stop/respawn, Claude-as-guardian
  permits, /clear nonce reset) is member-agnostic; only the spawn command and the
  user-facing strings differ. Two instances: `codex` and `grok`. Codex's tools and
  env vars are renamed in place (Codex now reads `MAGI_COUNCIL_CODEX_ACP_COMMAND`);
  Grok adds `MAGI_COUNCIL_GROK_ACP_COMMAND` (default `grok agent stdio`). Guardian
  flags, workspace, timeout, and log sink stay global/shared.

- **Grok surface is opt-in and explicit.** `ask_grok` (direct second opinion, full
  permit flow, advertises Grok's live web/X search + image/video), `grok_reply`
  (continue Grok's thread), and `grok_generate` (image/video → saved to disk;
  pauses for a write permit). Codex's tools never touch Grok.

- **The Magi council (`ask_magi`).** One round: **Codex always answers as the
  primary advisor**; **Grok joins only when warranted** — when Claude passes a
  `grok` angle (a disagreement to adjudicate, or a task needing X/web search), or
  when Codex itself ends with a `FOR GROK: <question>` line (Codex is told Grok is
  on the council and can pull it in). Sequential and **atomic**: both turns run
  with `onAskPermission: "deny"`, so a guardian "ask" is auto-denied inline instead
  of suspending — the whole council is a single tool call with no permit
  round-trips. Each member is caught independently, so Grok failing (e.g. out of
  usage) still returns Codex's answer. Claude is the third Magi and synthesizes.

- **Visible denials, not silent ones.** Auto-denies are logged in the same path as
  auto-allows (`auto-denied: …`), and `ask_magi` surfaces a per-member
  `⚠️ blocked in council mode: …` line — so a council answer can't look grounded
  after a quietly-denied read/command (the ADR 0003 transparency principle). The
  council prompt also tells members up front not to attempt commands/writes and to
  state what they couldn't inspect. (Grok's web/X search isn't a guardian action,
  so it still works in council mode.)

- **Out-of-usage is graceful for both members.** A thrown startup/turn error is
  rendered as a readable result (not an MCP error), and a quota/rate-limit/credit
  pattern is flagged as "looks out of usage / over quota" with the member's
  `loginHint`. Applies to Codex and Grok alike.

- **Permit ownership is explicit.** With two sessions, both can be paused at once
  (consult pauses Codex, then `ask_grok` pauses Grok). `permit` takes an optional
  `member`; it's inferred when exactly one is pending and **required** when both
  are, and the 🔐 message names the member. `reset` and `status` cover both members;
  /clear auto-reset already works per-session (each reads the shared workspace
  nonce independently).

**Why this shape.** Independent-but-selective beats both "always ask both" (wastes
Grok) and a multi-round debate engine (Grok-expensive, and the suspend-for-permit
model doesn't compose with orchestrating two suspendable turns in one call). Making
the council atomic via auto-deny keeps it a single, predictable call; pushing the
"when to spend Grok" decision to Claude (and letting Codex request Grok) matches
the user's rule — Codex is the daily driver, Grok is the specialist/tiebreaker.

**Consequences.** `ask_magi` runs two turns back-to-back, so it can be slow — the
streaming heartbeat keeps the MCP request alive, but clients that cap tool calls
should raise the limit (`MCP_TOOL_TIMEOUT`). Image/video generation happens only
via `grok_generate` (it writes files, which the council's auto-deny would block);
the council is aware of the capability and will suggest it rather than do it.
`grok_generate` is wired but untested for actual media output (it depends on
Grok's generation writing to disk and reporting a path / `resource_link`). Generic
ACP cross-talk Grok emits (`_x.ai/*` notifications, stray `skills-reload`
responses) is filtered from stderr so it doesn't spam the MCP logs.
