# 0017 — ACP model selection

**Context.** The host may want cheaper council members for budget-sensitive turns, but
model availability is member-specific and reported by each ACP session, not by this MCP
server's static config.

**Decision.** Add `available_councilors` to start requested active members and report
their ACP `model` selector values from `session/new` / `config_option_update`. Add
`model` to single-member tools and `models` to council fan-out (`consult` and
`member:"council"` structured tools); the server applies selections with
`session/set_config_option` before sending the prompt. The choice is session-level:
persistent member sessions keep it until changed or `reset`; `fresh` consults get the
selection only on their throwaway session.

**Why.** This keeps model names source-of-truth in the ACPs, avoids guessing provider
catalogs in env/config, and makes budget control explicit at the call site.
