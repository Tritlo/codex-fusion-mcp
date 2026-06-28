# codex-fusion-mcp

A small MCP server that lets **Claude consult a council of ACP-backed coding
agents mid-task** — for a second opinion, plan review, diff review,
brainstorming, and codebase exploration. **Codex is the head of the council**:
routine calls go to Codex, while Gemini CLI and Grok Build are explicit,
rare delegates for high-value second opinions. A lightweight take on model
*fusion*: Claude proposes, another agent reviews, Claude reconciles. (See OpenRouter's
[Fusion beats Frontier](https://openrouter.ai/blog/announcements/fusion-beats-frontier/) —
the synthesis step itself is where the gains come from.)

Internally it's an [ACP](https://agentclientprotocol.com) *client* that spawns
one configured ACP agent subprocess per council member and keeps one persistent
session per member per workspace. Built-in members:

| Member | Default ACP command | Notes |
|--------|---------------------|-------|
| `codex` | `bunx @agentclientprotocol/codex-acp` | Head of council; used whenever `member` is omitted. |
| `gemini` | `gemini --acp` | Rare explicit delegate; useful when model diversity is worth quota. |
| `grok` | `grok agent stdio` | Rare explicit delegate; useful when model diversity is worth quota. |

## Tools

| Tool | Use it to… |
|------|-----------|
| `consult` | get an independent second opinion on a specific question/decision |
| `review_plan` | have a council member critique a plan **before** you implement it |
| `review_diff` | have a council member review code changes (pass a diff, or let it read `git diff`) |
| `brainstorm` | get 2–4 alternative approaches with trade-offs + a recommendation |
| `explore` | map an unfamiliar codebase (structure, components, flow, conventions) |
| `reply` | continue the debate — push back on the same member's last answer |
| `permit` | allow/deny a permission a member raised mid-turn, then resume it |
| `reset` | drop accumulated member context and start fresh |
| `status` | report health: workspace, configured members, guardian flags, sessions, pending permissions |

All deliberative tools accept optional `member` (`codex`, `gemini`, `grok`, or a
custom configured id). Omit it to ask Codex. Gemini/Grok are never sticky defaults;
to continue a delegate debate, pass the same `member` again. All tools are
**advisory** — the member answers, you decide.

### Debate, not one-shot

The deliberative tools (`consult`, `review_plan`, `review_diff`, `brainstorm`)
frame each exchange as a short debate: the selected member pushes back, and ends every reply
with a `VERDICT: CONSENSUS — …` or `VERDICT: OPEN — …` line. When it's `OPEN`,
push back with `reply` (same persistent member session, so it keeps the thread)
and drive toward consensus — keep it to ~3 turns. For delegate debates, include
`member` on every follow-up.

### Permissions: Claude is the guardian

When a member wants to do something guardian doesn't auto-allow, the turn **pauses
and hands the decision back to Claude** — no static allowlist, no human prompt.
The tool returns `🔐 <member> paused … <what it wants>`; Claude judges whether
it's reasonable and calls `permit allow|deny`, which resolves the held-open
request and resumes the same suspended turn. Only the cheap, safe cases are
auto-allowed without asking: reads and searches **inside** the workspace. Everything else —
commands, writes, network, out-of-workspace reads — comes back to Claude. The
`ALLOW_*` flags downgrade a whole category from "ask Claude" to "auto-allow".

### Streaming & cancellation

Turns stream live: member text, reasoning (a `💭 …` thinking view), and a
`↳ …` activity trail are sent as MCP progress notifications, so you can watch
(and steer between turns). The reasoning stream doubles as a heartbeat — the MCP
client resets its request timeout on progress, so forwarding member thinking
keeps a long, silently-reasoning turn from being cancelled by the client. Cancel
a turn and the member is told to stop (`session/cancel`); if it ignores the cancel, a
short grace later the turn is hard-stopped and the subprocess respawned, so it
can't wedge the queue. The turn timeout is an **idle** timeout: it fires only
after `CODEX_FUSION_TURN_TIMEOUT_MS` of *silence* (no text, reasoning, or
tool-call output), and the clock resets on every chunk — so a turn that keeps
streaming is never cut off, however long it runs, and you keep its partial output
instead of losing it. Pass a per-call `time` (seconds) to any tool to widen that
idle window for a single big review/exploration. (The wait for a `permit`
decision is **not** timed.) If your client caps tool calls more tightly, raise
its timeout too — for Claude Code, `MCP_TOOL_TIMEOUT` (e.g. `600000`).
The tool result stays focused on the member's answer plus a one-line footer (latency,
tokens); the full play-by-play goes to the debug log.

### Sessions & reset

The server keeps **one persistent session per member per workspace** so each
member accumulates context across calls (collaborators, not stateless oracles).
That context outlives a Claude `/clear` — the MCP server isn't restarted then —
so without help the next conversation would land on agents that still remember
the last one. Two ways to clear it:

- **Automatic, on `/clear`** — install the `SessionStart` hook below. It writes
  the new Claude session id to a per-workspace nonce file; the server notices the
  change on each member's next turn and drops that session, so it starts fresh
  alongside Claude. (`compact`/`resume`/`startup` are intentionally left alone.)
- **Manual** — call the `reset` tool any time: switching to an unrelated task,
  when a member's context has grown stale over a long session, or to clear a
  wedged turn. Omit `member` to reset all configured members. It's also the
  fallback if the hook isn't installed.

Note the asymmetry: member context lives only as long as the server process, but
Claude's is persisted. After a Claude **resume**, a crash-respawn, or a reboot,
members start empty while Claude remembers — so a `reply` may land on a member
that no longer has the thread. Re-establish context (or `reset` and start clean)
if so.

## Requirements

- [Bun](https://bun.sh)
- For the head `codex` member: a working Codex login (`codex login`, or set
  `OPENAI_API_KEY`). `codex-acp` is fetched on demand via `bunx`; install it for
  speed if you prefer.
- For `gemini`: Gemini CLI installed and authenticated (`gemini`, or set
  `GEMINI_API_KEY`). Gemini ACP mode is `gemini --acp`.
- For `grok`: Grok Build installed and authenticated (`grok login`, or set
  `XAI_API_KEY`). Grok ACP mode is `grok agent stdio`.

```bash
bun install
```

## Register with Claude Code

```bash
claude mcp add codex-fusion -- bun run /ABS/PATH/codex-fusion-mcp/src/index.ts
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "codex-fusion": {
      "command": "bun",
      "args": ["run", "/ABS/PATH/codex-fusion-mcp/src/index.ts"],
      "env": { "CODEX_FUSION_WORKSPACE": "/ABS/PATH/your-project" }
    }
  }
}
```

### Reset council members on `/clear` (recommended)

Add a `SessionStart` hook so clearing the Claude conversation also clears member
context (see [Sessions & reset](#sessions--reset)). In `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "bun run /ABS/PATH/codex-fusion-mcp/hooks/session-reset.ts" }
        ]
      }
    ]
  }
}
```

The hook runs on every session start but only acts on `source == "clear"`; for
other sources it's a no-op. It keys the nonce file on the hook's `cwd`, which must
match the server's workspace (the default — `CODEX_FUSION_WORKSPACE` unset). Two
Claude windows in the **same** workspace share the nonce, so a `/clear` in one
resets council members for both; that only discards advisory context, never corrupts it.

## Configuration (env)

| Variable | Default | Meaning |
|----------|---------|---------|
| `CODEX_FUSION_WORKSPACE` | cwd | Absolute path members are scoped to; the base for every guardian check. |
| `CODEX_FUSION_MEMBERS` | `codex` | Comma-separated member ids to enable. Codex is always included as head, so `gemini,grok` enables all three. |
| `CODEX_FUSION_ACP_COMMAND` | `bunx @agentclientprotocol/codex-acp` | Backward-compatible override for the `codex` ACP command. |
| `CODEX_FUSION_<MEMBER>_ACP_COMMAND` | built-in default | Override a member ACP command, e.g. `CODEX_FUSION_GEMINI_ACP_COMMAND="gemini --acp"`. Required for custom member ids. |
| `CODEX_FUSION_<MEMBER>_DISPLAY_NAME` | built-in/custom id | Human name used in prompts and status. |
| `CODEX_FUSION_<MEMBER>_AUTH_METHODS` | member default | Comma-separated preferred ACP auth method ids. The server also auto-picks usable env-var/agent auth and ignores terminal auth. |
| `CODEX_FUSION_<MEMBER>_AUTH_HINT` | member default | Extra hint shown on auth/startup failures. |
| `CODEX_FUSION_ALLOW_EXTERNAL_READS` | off | Let members read outside the workspace + use network fetch. |
| `CODEX_FUSION_ALLOW_WRITES` | off | Let members edit/delete/move files inside the workspace. |
| `CODEX_FUSION_ALLOW_COMMANDS` | off | Let members run shell commands. |
| `CODEX_FUSION_TURN_TIMEOUT_MS` | `600000` | Idle timeout: abort a turn after this long of *silence* (clock resets on every chunk). Override per call with the `time` arg (seconds). |
| `CODEX_FUSION_LOG` | off | Append a full per-turn JSONL debug log to this path. |

Example:

```bash
CODEX_FUSION_MEMBERS=gemini,grok \
bun run src/index.ts
```

### Guardian mode

By default the server runs in **guardian mode**: members may only *read and
search inside the workspace* without asking. Everything else — writes, network
fetches, command execution, and reads that escape the workspace root — isn't
auto-refused; the turn **pauses and hands the request to Claude** to allow or deny (see
[Permissions: Claude is the guardian](#permissions-claude-is-the-guardian)), and
every decision is logged. So `review_diff` can run `git diff` the moment you
allow it — there's no static command allowlist to outwit (see ADR 0003). The
`ALLOW_*` flags downgrade a whole category (external reads + fetch, writes, or
commands) from "ask Claude" to auto-allow; the policy is a single pure function
in [`src/permissions.ts`](src/permissions.ts).

## Layout

```
src/config.ts       env → Config (guardian flags, turn timeout, debug log)
src/permissions.ts  guardianDecision — the pure permission policy
src/prompts.ts      block-structured prompt per tool (+ debate frame)
src/acp.ts          ACP client: spawn member subprocesses, persistent session, streaming ask()
src/reset.ts        per-workspace reset-nonce path (shared by server + hook)
src/log.ts          per-turn debug log (stderr summary + optional JSONL file)
src/index.ts        MCP server: the tools, streaming + cancellation wiring
hooks/session-reset.ts  SessionStart hook: reset member context on Claude /clear
docs/adr/0001-*.md  design decisions
```
