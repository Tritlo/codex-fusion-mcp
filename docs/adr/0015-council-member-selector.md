# 0015 — Council member selector

**Context.** `consult` hard-coded its participants to `activeIds()` — every member
except the host. Sometimes you want to convene just a **subset** (e.g. only Codex this
call).

**Decision.** Add `members?: ("claude"|"codex"|"grok")[]` to `consult`:

- **Omitted** → the default council = `activeIds()` (host-excluded) — unchanged.
- **Provided** → those members **intersected with the active set** (`selectCouncil`,
  pure + unit-tested): deduped, in canonical order. The host is never a member, so
  naming it is simply dropped — it can't be made to consult itself.

`runMagi`/`councilFanOut` thread the selected ids instead of hard-coding `activeIds()`.
Structured tools (`member:"council"`) are unchanged.

**Why.** Generalizes *who* sits on the council with a small additive change.

**Note (superseded direction).** An earlier draft of this ADR let `members` name the
*host's own* model to spawn it as a participant (`claude-agent-acp`). That was **cut**:
the right way for the host to participate is to *drive* the deliberation, not to spawn a
sibling instance — see ADR 0016. The selector is now subset-of-advisors only.

**Consequences.** In the common two-advisor setup a subset is just "pick one" (which
overlaps `ask_*`); the selector earns its keep with three active advisors or for a
read-only single opinion. Verified live: `consult({members:["codex"]})` through a real
MCP client → `codex-acp` returned a clean single-voice result.
