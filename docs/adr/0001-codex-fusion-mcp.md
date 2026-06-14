# 0001 — codex-fusion-mcp design

**Context.** Claude (Claude Code) does better work when a second, architecturally
different model reviews its decisions and co-plans — OpenRouter's "fusion"
result shows the synthesis step itself adds value, even before model diversity.
`codex-acp` already exposes Codex (GPT-5.x) over ACP. We want a lightweight
way for Claude to consult Codex mid-task.

**Decision.** Ship an MCP stdio server that is internally an ACP *client* of a
spawned `codex-acp` process, exposing five advisory tools — `consult`,
`review_plan`, `review_diff`, `brainstorm`, `explore`. Claude calls a tool,
Codex answers, and Claude remains the judge that reconciles the second opinion.

Key choices:

- **One persistent ACP session per workspace**, created lazily and reused, so
  Codex accumulates context across calls (a collaborator, not a stateless
  oracle). Prompt turns are serialized over the single session.
- **Guardian permission policy, decided by the MCP, not the human.** Codex's
  ACP permission requests are auto-resolved by a pure policy
  (`guardianDecision`). Default (guardian) allows only reads inside the
  workspace and refuses writes, command execution, network fetches, and any
  read that escapes the workspace root. Three env flags widen exactly one
  category each: `CODEX_FUSION_ALLOW_EXTERNAL_READS`, `…_ALLOW_WRITES`,
  `…_ALLOW_COMMANDS`. Every decision is logged into the tool result so Claude
  sees what Codex did or was blocked from doing. No human round-trip — that was
  the explicit "simpler alternative, default to guardian" call.
- **TypeScript + Bun, strict.** Matches `codex-acp` (Bun) and reuses its own
  `@agentclientprotocol/sdk` for the client side; `@modelcontextprotocol/sdk`
  for the server side.
- **Prompts are block-structured** (Codex prompting recipes + the GPT-5.2
  guide): one task, an explicit output contract, grounding/verification, and
  dig-deeper/research blocks per tool. Reasoning effort/model left at Codex's
  defaults.

**Consequences.** Safe-by-default: out of the box Codex can only read the
project it's pointed at. Expansion is a deliberate env toggle. Because turns
are serialized and the session is persistent, Codex stays coherent across a
working session but only one consult runs at a time. Auth piggybacks on the
user's existing Codex login; a missing login surfaces as a tool error pointing
to `/codex:setup`.
