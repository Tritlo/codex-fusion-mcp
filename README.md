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

**The council** — fans out to every advisor (the members other than you):

| Tool | Use it to… |
|------|-----------|
| `consult` | convene the council on a question — each advisor gives an independent view, you synthesize. **Deliberation is host-mediated**: it returns one round; weigh in (`my_take`) and **call again** to run the next round, iterating until you judge agreement. `members` picks who sits on the council (a subset); `fresh` runs each advisor on a throwaway session (no cross-call context) |

**Ask one advisor directly** (a member's pair appears only when it isn't the host):

| Tool | Use it to… |
|------|-----------|
| `ask_codex` / `codex_reply` | a second opinion from Codex (GPT-5), and follow-ups |
| `ask_grok` / `grok_reply` | a second opinion from Grok — live web/X search, current events |
| `ask_claude` / `claude_reply` | a second opinion from Claude (generalist coder) |
| `grok_generate` | generate an image or short video with Grok, saved into the workspace |

**Structured single-advisor passes** — each takes an optional `member` (default Codex, or `"council"` to fan out to all):

| Tool | Use it to… |
|------|-----------|
| `review_plan` | critique a plan **before** you implement it (verdict / problems / blind spots) |
| `review_diff` | review code changes (pass a diff, or let the advisor read `git diff`) |
| `brainstorm` | get 2–4 alternative approaches with trade-offs + a recommendation |
| `explore` | map an unfamiliar codebase (structure, components, flow, conventions) |

**Shared:**

| Tool | Use it to… |
|------|-----------|
| `permit` | allow/deny a permission a member raised mid-turn, then resume it (pass `member` if more than one is paused) |
| `reset` | drop **all** members' accumulated context and start fresh sessions |
| `status` | report the resolved host, the active council, and each active member's health |
| `available_councilors` | start active members if needed and report ACP model selector values |

All tools are **advisory** — the members answer, you decide. A member's direct
tools (`ask_*`/`*_reply`) appear **only when that member isn't the host**; the
council and the structured tools are always present and target the active members.

### Symmetric council & host detection

The council is **symmetric** — any of the three agents can host it. On MCP
`initialize` the server reads the connecting client's identity and **excludes that
member** (the host), leaving the other two as the council. Resolution order:

1. **`MAGI_COUNCIL_EXCLUDE`** (`claude`|`codex`|`grok`, startup only) — explicit, wins.
2. **`clientInfo.name`** sent at `initialize` — matched against `claude`/`codex`/`grok`.
3. **unknown** — if neither resolves, *all three* members participate (one may be
   the host). `status` and `consult` flag this, so an unrecognized host knows it
   can set the env var to exclude itself.

When the host is known, its direct tools are removed and every handler also guards
at call time, so it can't consult itself even if a client ignores the updated tool
list. **Giving other agents the council** is just registering this server in their
MCP config — see [Other agents](#giving-other-agents-the-council).

### Debate, not one-shot

The single-advisor tools (`ask_codex`/`ask_grok`/`ask_claude`, `review_plan`,
`review_diff`, `brainstorm`) frame each exchange as a short debate: the advisor
pushes back, and ends every reply with a `VERDICT: CONSENSUS — …` or
`VERDICT: OPEN — …` line. When it's `OPEN`, push back with that advisor's reply
tool (same persistent session, so the thread is kept) and drive toward consensus —
keep it to ~3 turns.

### The Magi council (`consult`)

`consult` convenes your advisors — the council members other than you — on one
question. **Every active advisor weighs in** with an *independent* view (no cross-talk;
Grok leans on its live web/X search where it helps), and you synthesize.

**Deliberation is host-mediated** (ADR 0016): `consult` runs **one round** and returns,
telling you to form your own position and **call `consult` again** — with `my_take` set
to your evolving position — to run the next round. The advisors keep their context
(persistent sessions) and respond to *you*; you iterate until you judge agreement is
reached, then act on it. So **you are a real participant**, not just the reader of an
autonomous debate: cross-pollination flows through you (you integrate the voices and
feed them back), round by round, for as long as it's worth it. There's no internal
multi-round mode — the host drives the rounds.

Pass **`members`** to choose who sits on the council for one call (default: every
active advisor — the members other than you). Name a subset to convene just those (the
host is never a member — it participates by driving the rounds, not by being spawned;
ADR 0015).

Pass **`fresh`** to run each advisor on a **throwaway session** — independent of any
prior conversation and discarded when the consult ends — so the council's votes
don't carry or leave cross-call context. It's slower (each advisor spawns fresh) and
forfeits the accumulated "collaborator" memory, so it's opt-in; the default reuses
the persistent sessions. (`fresh` is the lightweight end of the council-memory
trade-off; the durable other end is the proposed `MAGI.md`, ADR 0011.)

### Model selection

Call **`available_councilors`** to see the ACP model selector values reported by
the active members. Use the value at the start of each model row, not the display
label. For example, Claude may report values like:

```text
default
opus[1m]
claude-fable-5[1m]
sonnet
haiku
```

Then pass **`models`** to choose per-member models for a council fan-out:

```json
{
  "members": ["claude"],
  "models": { "claude": "opus[1m]" },
  "question": "Review this risky design decision."
}
```

Single-advisor tools take **`model`** instead:

```json
{
  "model": "sonnet",
  "question": "Give me a quick second opinion."
}
```

Model selection is ACP session-level. On persistent sessions it remains until
changed or `reset`; with `fresh`, it applies only to that throwaway session. If a
member does not report a model selector, or you pass an unavailable value, the tool
returns a readable member-specific error instead of guessing a fallback. Use Opus
for high-leverage reviews; keep Fable/Sonnet/Haiku for routine checks so the
council does not silently eat the expensive budget.

It runs members **concurrently** and **atomically** — every advisor's turn fans out
at once (each on its own session), rendered back in member order, as a single tool
call with no permit round-trips. A council turn is **read-only**: members may read any files and
search/fetch to ground their answers, but writes and command execution are
auto-denied (and surfaced as a `⚠️ blocked in council mode: …` line, so a
grounded-looking answer can't hide a quietly-denied action). Grok's web/X search
isn't a guardian action, so it works in-council too. Each member is handled
independently, so if one is unavailable you still get the others.

The structured tools (`review_plan`/`review_diff`/`brainstorm`/`explore`) also take
**`member: "council"`** to fan out one round to every advisor (independent panel,
no multi-round deliberation). Since council mode is read-only, a `member:"council"`
`review_diff` can't run `git diff` (a command) — use single-advisor `review_diff`
(which can, via a permit) for that. For **image/video generation** use
`grok_generate` (it writes a file, which read-only council mode would block); the
council is aware of the capability and will suggest it rather than do it.

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
suspends — it runs read-only, resolving permissions inline — so it never leaves a
pending permit.)

The server also advertises a **read-only client filesystem** (ACP
`fs/read_text_file`), sandboxed to the workspace (or anywhere with
`MAGI_COUNCIL_ALLOW_EXTERNAL_READS`). This gives agents a non-shell read path — the
reason a command-based reader like Codex can read inside read-only council mode at
all. It never advertises `writeTextFile`, so writes still go through the guardian.

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
its timeout too — for Claude Code, `MCP_TOOL_TIMEOUT` (e.g. `600000`); `consult`
runs every advisor concurrently in one round, so it benefits from a generous cap.
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
advisors start empty while the host remembers — so a follow-up reply may land on an
advisor that no longer has the thread. Re-establish context (or `reset` and start clean) if so.

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
`consult`). Check `status` to confirm the resolved host and active council.

For Codex CLI/IDE specifically, either add it with the CLI:

```bash
codex mcp add magi-council \
  --env MAGI_COUNCIL_EXCLUDE=codex \
  --env MAGI_COUNCIL_WORKSPACE=/ABS/PATH/your-project \
  -- /ABS/PATH/TO/bun run /ABS/PATH/magi-council-mcp/src/index.ts
```

Or put this in `~/.codex/config.toml` (or a trusted project `.codex/config.toml`):

```toml
[mcp_servers.magi-council]
command = "/ABS/PATH/TO/bun"
args = ["run", "/ABS/PATH/magi-council-mcp/src/index.ts"]
startup_timeout_sec = 20
tool_timeout_sec = 600

[mcp_servers.magi-council.env]
MAGI_COUNCIL_EXCLUDE = "codex"
MAGI_COUNCIL_WORKSPACE = "/ABS/PATH/your-project"
```

Then restart Codex or start a new session and run `/mcp` to confirm the server is
connected. Use `command -v bun` to find the Bun path; an absolute command avoids
startup failures when Codex's MCP launcher does not inherit your interactive shell
`PATH`.

`MAGI_COUNCIL_WORKSPACE` is optional: if omitted, the server scopes members to the
MCP process cwd. For a project-specific config you can instead set
`cwd = "/ABS/PATH/your-project"` on `[mcp_servers.magi-council]` and omit the
workspace env var.

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
src/council.ts      pure council-selection logic (selectCouncil)
src/prompts.ts      host-parameterized prompts per tool (Codex/Grok/Claude, magi, generate)
src/session.ts      AcpSession — ACP client: spawn a member, model config, persistent session, streaming ask()
src/reset.ts        per-workspace reset-nonce path (shared by server + hook)
src/log.ts          per-turn debug log (stderr summary + optional JSONL file)
src/index.ts        MCP server: 3 member sessions, host detection + tool gating, the Magi council
hooks/session-reset.ts  SessionStart hook: reset members on the host's /clear (Claude Code)
test/fake-acp.ts    a scripted ACP agent subprocess for tests (behavior by --scenario)
test/*.test.ts      bun test: AcpSession lifecycle (E2E vs the fake) + pure council logic
docs/adr/000*.md    design decisions
```

## Tests

```bash
bun test       # deterministic, no network and no real model calls (a few seconds)
bun run typecheck
```

`test/session.test.ts` drives `AcpSession` end-to-end against `test/fake-acp.ts` — a
real ACP *agent* subprocess scripted by `--scenario` — through the genuine
spawn → prompt → permission → cancel path, covering suspend/resume, reset, idle
timeout, external cancel, crash-fails-fast, gate serialization, and nonce reset.
`test/council.test.ts` unit-tests the pure council-selection logic in `src/council.ts`.
