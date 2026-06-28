# magi-council-mcp

A small MCP server that lets a coding agent **consult other frontier models
mid-task** — **Codex (GPT-5.x)**, **Grok (xAI)**, and **Claude (Anthropic)** —
for a second opinion, plan review, diff review, brainstorming, exploration, media
generation, and a three-way **Magi council**. A lightweight take on model
*fusion*: the host proposes, the others review, the host reconciles. (See
OpenRouter's
[Fusion beats Frontier](https://openrouter.ai/blog/announcements/fusion-beats-frontier/) —
the synthesis step itself is where the gains come from.)

The three "Magi" are **Claude, Codex, and Grok**. The server is **symmetric**:
whichever agent launches it is the *host* (the lead, who synthesizes) and — when
recognized — is **auto-excluded from its own council**, so each host gets the
*other two* as advisors (Claude convenes Codex+Grok, Codex convenes Claude+Grok,
…). An unrecognized host gets all three (and may include itself) until you set
`MAGI_COUNCIL_EXCLUDE` (see [Symmetric council](#symmetric-council--host-detection)).

Internally it's an [ACP](https://agentclientprotocol.com) *client* that spawns each
non-host member's ACP server —
[`codex-acp`](https://www.npmjs.com/package/@agentclientprotocol/codex-acp),
`grok agent stdio`, and
[`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) —
keeping one persistent session per member per workspace.

## Tools

A member's direct tools appear **only when that member isn't the host**. With the
common Claude host you see Codex + Grok tools (and the Claude tools are hidden);
with a Codex host you'd see Claude + Grok tools instead, and so on.

**Codex** (the default primary advisor):

| Tool | Use it to… |
|------|-----------|
| `consult` | get an independent second opinion on a specific question/decision |
| `review_plan` | have Codex critique a plan **before** you implement it |
| `review_diff` | have Codex review code changes (pass a diff, or let it read `git diff`) |
| `brainstorm` | get 2–4 alternative approaches with trade-offs + a recommendation |
| `explore` | map an unfamiliar codebase (structure, components, flow, conventions) |
| `reply` | continue the debate — push back on Codex's last answer on the same session |

**Grok** (xAI):

| Tool | Use it to… |
|------|-----------|
| `ask_grok` | ask Grok directly — second opinion with live web/X search, current events |
| `grok_reply` | continue the conversation with Grok on the same session |
| `grok_generate` | generate an image or short video with Grok, saved into the workspace |

**Claude** (only when the host isn't Claude):

| Tool | Use it to… |
|------|-----------|
| `ask_claude` | ask Claude directly — an independent generalist-coder second opinion |
| `claude_reply` | continue the conversation with Claude on the same session |

**Council & shared:**

| Tool | Use it to… |
|------|-----------|
| `ask_magi` | convene the council — every active advisor gives an independent view; you synthesize |
| `permit` | allow/deny a permission a member raised mid-turn, then resume it (pass `member` if more than one is paused) |
| `reset` | drop **all** members' accumulated context and start fresh sessions |
| `status` | report the resolved host, the active council, and each active member's health |

All tools are **advisory** — the members answer, you decide.

### Symmetric council & host detection

The council is **symmetric** — any of the three agents can host it. On MCP
`initialize` the server reads the connecting client's identity and **excludes that
member** (the host), leaving the other two as the council. Resolution order:

1. **`MAGI_COUNCIL_EXCLUDE`** (`claude`|`codex`|`grok`, startup only) — explicit, wins.
2. **`clientInfo.name`** sent at `initialize` — matched against `claude`/`codex`/`grok`.
3. **unknown** — if neither resolves, *all three* members participate (one may be
   the host). `status` and `ask_magi` flag this, so an unrecognized host knows it
   can set the env var to exclude itself.

When the host is known, its direct tools are removed and every handler also guards
at call time, so it can't consult itself even if a client ignores the updated tool
list. **Giving other agents the council** is just registering this server in their
MCP config — see [Other agents](#giving-other-agents-the-council).

### Debate, not one-shot

The deliberative tools (`consult`, `review_plan`, `review_diff`, `brainstorm`)
frame each exchange as a short debate: the advisor pushes back, and ends every
reply with a `VERDICT: CONSENSUS — …` or `VERDICT: OPEN — …` line. When it's
`OPEN`, push back with `reply` (same persistent session, so the thread is kept)
and drive toward consensus — keep it to ~3 turns.

### The Magi council (`ask_magi`)

`ask_magi` convenes your advisors — the council members other than you — on one
question, and you synthesize. **Every active advisor weighs in**, each giving an
independent view (Grok leans on its live web/X search where it helps).

It runs members **sequentially** and **atomically** — a single tool call, no
permit round-trips: a council turn auto-denies anything guardian would otherwise
ask about, and surfaces a `⚠️ blocked in council mode: …` line so a grounded-looking
answer can't hide a quietly-denied action. (Grok's web/X search isn't a guardian
action, so it still works in-council.) Each member is handled independently, so if
one is unavailable you still get the others. You're the lead: read the voices and
decide, then follow up with the active members' reply tools.

For actual **image/video generation** use `grok_generate` (it writes a file, which
the council's auto-deny would block); the council is aware of the capability and
will suggest it rather than do it.

### Permissions: the host is the guardian

When a member wants to do something guardian doesn't auto-allow, the turn **pauses
and hands the decision back to the host** — no static allowlist, no human prompt.
The tool returns `🔐 <member> paused … <what it wants>`; the host judges whether it's
reasonable and calls `permit allow|deny`, which resolves the held-open request
and resumes the same suspended turn. Only the cheap, safe cases are auto-allowed
without asking: reads and searches **inside** the workspace. Everything else —
commands, writes, network, out-of-workspace reads — comes back to the host. The
`ALLOW_*` flags downgrade a whole category from "ask" to "auto-allow".

All advisors share this guardian. Since each has its own session, **more than one
can be paused at once** (e.g. a `consult` pauses Codex, then an `ask_grok` pauses
Grok); `permit` takes an optional **`member`** (`claude`|`codex`|`grok`) — inferred
when only one is pending, required when several are. (The Magi council never
suspends — it auto-denies instead — so it never leaves a pending permit.)

### Running out of usage

Any member can hit usage/rate limits. When a member can't start or its turn fails,
the tool returns a readable message instead of a hard error — and a
quota/rate-limit/credit failure is flagged as "looks out of usage / over quota"
with how to recover. In the council, one member running out still returns the others.

### Streaming & cancellation

Turns stream live: the member's text, its reasoning (a `💭 …` thinking view), and a
`↳ …` activity trail are sent as MCP progress notifications, so you can watch
(and steer between turns). In the council, each voice's stream is prefixed
(`Codex …` / `Grok …`). The reasoning stream doubles as a heartbeat — the MCP
client resets its request timeout on progress, so forwarding the thinking
keeps a long, silently-reasoning turn from being cancelled by the client. Cancel
a turn and the member is told to stop (`session/cancel`); if it ignores the cancel, a
short grace later the turn is hard-stopped and the subprocess respawned, so it
can't wedge the queue. The turn timeout is an **idle** timeout: it fires only
after `MAGI_COUNCIL_TURN_TIMEOUT_MS` of *silence* (no text, reasoning, or
tool-call output), and the clock resets on every chunk — so a turn that keeps
streaming is never cut off, however long it runs, and you keep its partial output
instead of losing it. Pass a per-call `time` (seconds) to any tool to widen that
idle window for a single big review/exploration. (The wait for a `permit`
decision is **not** timed.) If your client caps tool calls more tightly, raise
its timeout too — for Claude Code, `MCP_TOOL_TIMEOUT` (e.g. `600000`); `ask_magi`
runs two turns back-to-back, so it benefits most from a generous cap.
The tool result stays focused on the member's answer plus a one-line footer
(latency, tokens — Grok reports latency only); the full play-by-play goes to the
debug log.

### Sessions & reset

The server keeps **one persistent session per member per workspace** so each
accumulates context across calls (a collaborator, not a stateless oracle). That
context outlives the host's `/clear` — the MCP server isn't restarted then — so
without help the next conversation would land on members that still remember the
last one. `reset` clears **all** members. Two ways to clear it:

- **Automatic, on `/clear`** — install the `SessionStart` hook below. It writes
  the new session id to a per-workspace nonce file; the server notices the change
  on its next turn and drops the members' sessions, so they start fresh alongside
  the host. (`compact`/`resume`/`startup` are intentionally left alone.) **This
  hook is Claude Code-specific** — for a Codex/Grok host, use the manual `reset`
  tool instead.
- **Manual** — call the `reset` tool any time: switching to an unrelated task,
  when a member's context has grown stale over a long session, or to clear a wedged
  turn. It's also the fallback if the hook isn't installed.

Note the asymmetry: an advisor's context lives only as long as the server process,
but the host's is persisted. After a host **resume**, a crash-respawn, or a reboot,
advisors start empty while the host remembers — so a `reply` may land on an advisor
that no longer has the thread. Re-establish context (or `reset` and start clean) if so.

## Requirements

- [Bun](https://bun.sh)
- A working Codex login (`codex login`, or set `OPENAI_API_KEY`). `codex-acp` is
  fetched on demand via `bunx`; install it for speed if you prefer.
- For the Grok tools (`ask_grok`, `grok_reply`, `grok_generate`) and Grok's seat
  on the council: the [Grok CLI](https://x.ai) on your `PATH` and a working login
  (`grok login`) with available usage.
- For Claude's seat on the council (only when the host **isn't** Claude):
  [`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp),
  fetched on demand via `bunx`, plus a working Claude login / `ANTHROPIC_API_KEY`.
  **Experimental** — not yet smoke-tested as an advisor; disable by setting
  `MAGI_COUNCIL_CLAUDE_ACP_COMMAND` to a no-op or excluding Claude.

Each member is **optional and lazy** — only spawned when one of its tools (or a
council turn that brings it in) is actually called. With the usual Claude host, the
Claude member never spawns.

```bash
bun install
```

## Register with Claude Code

```bash
claude mcp add magi-council -- bun run /ABS/PATH/magi-council-mcp/src/index.ts
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "magi-council": {
      "command": "bun",
      "args": ["run", "/ABS/PATH/magi-council-mcp/src/index.ts"],
      "env": { "MAGI_COUNCIL_WORKSPACE": "/ABS/PATH/your-project" }
    }
  }
}
```

### Reset the council on `/clear` (recommended)

Add a `SessionStart` hook so clearing the Claude conversation also clears the
members' context (see [Sessions & reset](#sessions--reset)). In `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "bun run /ABS/PATH/magi-council-mcp/hooks/session-reset.ts" }
        ]
      }
    ]
  }
}
```

The hook runs on every session start but only acts on `source == "clear"`; for
other sources it's a no-op. It keys the nonce file on the hook's `cwd`, which must
match the server's workspace (the default — `MAGI_COUNCIL_WORKSPACE` unset). Two
Claude windows in the **same** workspace share the nonce, so a `/clear` in one
resets the members for both; that only discards advisory context, never corrupts it.

### Giving other agents the council

Because the host is auto-excluded, the same server works for **Codex** or **Grok**
as host — register it in their MCP config the same way. The server tries to detect
the host from the client's `initialize` identity, but detection isn't guaranteed,
so **set `MAGI_COUNCIL_EXCLUDE` explicitly** for non-Claude hosts, e.g. in a Codex
host's MCP server env:

```json
{ "command": "bun", "args": ["run", "/ABS/PATH/magi-council-mcp/src/index.ts"],
  "env": { "MAGI_COUNCIL_EXCLUDE": "codex", "MAGI_COUNCIL_WORKSPACE": "/ABS/PATH/your-project" } }
```

That host then gets Claude + Grok as its council (`ask_claude`, `ask_grok`,
`ask_magi`). Check `status` to confirm the resolved host and active council.

## Configuration (env)

| Variable | Default | Meaning |
|----------|---------|---------|
| `MAGI_COUNCIL_WORKSPACE` | cwd | Absolute path the members are scoped to; the base for every guardian check. |
| `MAGI_COUNCIL_EXCLUDE` | (auto) | Force the host member to exclude (`claude`\|`codex`\|`grok`). Wins over clientInfo detection; recommended for non-Claude hosts. |
| `MAGI_COUNCIL_CLAUDE_ACP_COMMAND` | `bunx @agentclientprotocol/claude-agent-acp` | How to launch Claude's ACP server (used only when Claude isn't the host). |
| `MAGI_COUNCIL_CODEX_ACP_COMMAND` | `bunx @agentclientprotocol/codex-acp` | How to launch Codex's ACP server. |
| `MAGI_COUNCIL_GROK_ACP_COMMAND` | `grok agent stdio` | How to launch Grok's ACP server. |
| `MAGI_COUNCIL_ALLOW_EXTERNAL_READS` | off | Let a member read outside the workspace + use network fetch. |
| `MAGI_COUNCIL_ALLOW_WRITES` | off | Let a member edit/delete/move files inside the workspace. |
| `MAGI_COUNCIL_ALLOW_COMMANDS` | off | Let a member run shell commands. |
| `MAGI_COUNCIL_TURN_TIMEOUT_MS` | `600000` | Idle timeout: abort a turn after this long of *silence* (clock resets on every chunk). Override per call with the `time` arg (seconds). |
| `MAGI_COUNCIL_LOG` | off | Append a full per-turn JSONL debug log to this path. |

### Guardian mode

By default the server runs in **guardian mode**: a member may only *read and search
inside the workspace* without asking. Everything else — writes, network fetches,
command execution, and reads that escape the workspace root — isn't auto-refused;
the turn **pauses and hands the request to the host** to allow or deny (see
[Permissions: the host is the guardian](#permissions-the-host-is-the-guardian)), and
every decision is logged. So `review_diff` can run `git diff` the moment you
allow it — there's no static command allowlist to outwit (see ADR 0003). The
`ALLOW_*` flags downgrade a whole category (external reads + fetch, writes, or
commands) from "ask the host" to auto-allow; the policy is a single pure function
in [`src/permissions.ts`](src/permissions.ts).

## Layout

```
src/config.ts       env → Config + 3 per-member MemberSpecs + host-exclude override
src/permissions.ts  guardianDecision — the pure permission policy
src/prompts.ts      host-parameterized prompts per tool (Codex/Grok/Claude, magi, generate)
src/session.ts      AcpSession — ACP client: spawn a member, persistent session, streaming ask()
src/reset.ts        per-workspace reset-nonce path (shared by server + hook)
src/log.ts          per-turn debug log (stderr summary + optional JSONL file)
src/index.ts        MCP server: 3 member sessions, host detection + tool gating, the Magi council
hooks/session-reset.ts  SessionStart hook: reset members on the host's /clear (Claude Code)
docs/adr/000*.md    design decisions
```
