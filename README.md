# codex-fusion-mcp

A small MCP server that lets **Claude consult Codex (GPT-5.x) mid-task** — for a
second opinion, plan review, diff review, brainstorming, and codebase
exploration. A lightweight take on model *fusion*: Claude proposes, Codex
reviews, Claude reconciles. (See OpenRouter's
[Fusion beats Frontier](https://openrouter.ai/blog/announcements/fusion-beats-frontier/) —
the synthesis step itself is where the gains come from.)

Internally it's an [ACP](https://agentclientprotocol.com) *client* that spawns
[`codex-acp`](https://www.npmjs.com/package/@agentclientprotocol/codex-acp) and
keeps one persistent Codex session per workspace.

## Tools

| Tool | Use it to… |
|------|-----------|
| `consult` | get an independent second opinion on a specific question/decision |
| `review_plan` | have Codex critique a plan **before** you implement it |
| `review_diff` | have Codex review code changes (pass a diff, or let it read `git diff`) |
| `brainstorm` | get 2–4 alternative approaches with trade-offs + a recommendation |
| `explore` | map an unfamiliar codebase (structure, components, flow, conventions) |
| `reply` | continue the debate — push back on Codex's last answer on the same session |
| `status` | report health: workspace, guardian flags, whether Codex is alive |

All tools are **advisory** — Codex answers, you decide.

### Debate, not one-shot

The deliberative tools (`consult`, `review_plan`, `review_diff`, `brainstorm`)
frame each exchange as a short debate: Codex pushes back, and ends every reply
with a `VERDICT: CONSENSUS — …` or `VERDICT: OPEN — …` line. When it's `OPEN`,
push back with `reply` (same persistent session, so Codex keeps the thread) and
drive toward consensus — keep it to ~3 turns.

### Streaming & cancellation

Turns stream live: Codex's text and a `↳ reading …` activity trail are sent as
MCP progress notifications, so you can watch (and steer between turns). Cancel a
turn and Codex is told to stop (`session/cancel`). A turn that runs past
`CODEX_FUSION_TURN_TIMEOUT_MS` is aborted so it can't wedge the queue. The tool
result stays focused on Codex's answer plus a one-line footer (latency, tokens,
and any blocked actions); the full play-by-play goes to the debug log.

## Requirements

- [Bun](https://bun.sh)
- A working Codex login (`codex login`, or set `OPENAI_API_KEY`). `codex-acp` is
  fetched on demand via `bunx`; install it for speed if you prefer.

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

## Configuration (env)

| Variable | Default | Meaning |
|----------|---------|---------|
| `CODEX_FUSION_WORKSPACE` | cwd | Absolute path Codex is scoped to; the base for every guardian check. |
| `CODEX_FUSION_ACP_COMMAND` | `bunx @agentclientprotocol/codex-acp` | How to launch codex-acp. |
| `CODEX_FUSION_ALLOW_EXTERNAL_READS` | off | Let Codex read outside the workspace + use network fetch. |
| `CODEX_FUSION_ALLOW_WRITES` | off | Let Codex edit/delete/move files inside the workspace. |
| `CODEX_FUSION_ALLOW_COMMANDS` | off | Let Codex run shell commands. |
| `CODEX_FUSION_TURN_TIMEOUT_MS` | `120000` | Abort a single Codex turn after this long. |
| `CODEX_FUSION_LOG` | off | Append a full per-turn JSONL debug log to this path. |

### Guardian mode

By default the server runs in **guardian mode**: Codex may only *read inside the
workspace*. Writes, command execution, network fetches, and reads that escape
the workspace root are refused automatically, and each decision is reported back
to Claude in the tool result (so you can see what Codex wanted). Flip the
`ALLOW_*` flags to widen one category at a time. The policy lives in
[`src/permissions.ts`](src/permissions.ts) as a single pure function.

## Layout

```
src/config.ts       env → Config (guardian flags, turn timeout, debug log)
src/permissions.ts  guardianDecision — the pure permission policy
src/prompts.ts      block-structured prompt per tool (+ debate frame)
src/codex.ts        ACP client: spawn codex-acp, persistent session, streaming ask()
src/log.ts          per-turn debug log (stderr summary + optional JSONL file)
src/index.ts        MCP server: the tools, streaming + cancellation wiring
docs/adr/0001-*.md  design decisions
```
