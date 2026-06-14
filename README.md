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

All tools are **advisory** — Codex answers, you decide.

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

### Guardian mode

By default the server runs in **guardian mode**: Codex may only *read inside the
workspace*. Writes, command execution, network fetches, and reads that escape
the workspace root are refused automatically, and each decision is reported back
to Claude in the tool result (so you can see what Codex wanted). Flip the
`ALLOW_*` flags to widen one category at a time. The policy lives in
[`src/permissions.ts`](src/permissions.ts) as a single pure function.

## Layout

```
src/config.ts       env → Config (incl. guardian flags)
src/permissions.ts  guardianDecision — the pure permission policy
src/prompts.ts      block-structured prompt per tool
src/codex.ts        ACP client: spawn codex-acp, persistent session, ask()
src/index.ts        MCP server: the five tools
docs/adr/0001-*.md  design decisions
```
