# 0008 — Symmetric tool surface + council deliberation

**Context.** After ADR 0007 the tool names were asymmetric, inherited from the
codex-fusion era: `consult`/`review_plan`/`review_diff`/`brainstorm`/`explore`/`reply`
were Codex-only with generic names, while the other members used `ask_grok`/`ask_claude`
and the council was `ask_magi`. So `consult` *looked* like "ask the council" but
was really "ask Codex", and there was no `ask_codex`. The review tools were
Codex-only by history, not capability — they're just specialized prompts that run
through the same `AcpSession`/guardian as any member. Separately, the council was a
panel of *independent* opinions; it didn't actually deliberate.

**Decision.**

- **Council = `consult`.** `ask_magi` → `consult`: the one tool that fans out to
  every active advisor. (The "magi" brand stays in the project/server name.)

- **Symmetric direct tools.** `ask_codex`/`ask_grok`/`ask_claude` (+ `*_reply`) for
  one specific advisor; old `consult` → `ask_codex`, old `reply` → `codex_reply`.
  A member's pair is hidden when it's the host.

- **Deliberative tools are per-member, default Codex.** `review_plan`/`review_diff`/
  `brainstorm`/`explore` take an optional `member` (a specific advisor, or
  `"council"` to fan out one round to all). They're always registered (not tied to
  one member's host status) and resolve to the requested advisor, else Codex, else
  the first active advisor. Each prompt builder now takes the advisor name, since
  nothing about them was Codex-specific.

- **Real deliberation in `consult`.** `rounds` (default 1) and `until_settled`:
  - `rounds = 1` — independent panel (prior behavior).
  - `rounds > 1` — round 1 independent (no anchoring), then each advisor sees every
    advisor's previous-round answers and rebuts/refines, ending with a
    `VERDICT: CONSENSUS/OPEN` line.
  - `until_settled` — treat `rounds` as a max; stop early when *all* advisors hit
    CONSENSUS (settled) or the normalized VERDICT lines stop changing between rounds
    (stalemate). The outcome is labelled settled / stalemate / cap-reached. Capped
    at 8 rounds. Deliberation reuses the atomic fan-out, so it stays a single tool
    call across all rounds. Scoped to `consult`; the `member:"council"` fan-out on
    the structured tools stays one round.

- **Council mode is read-only, not deny-all.** ADR 0006's council auto-denied
  *every* guardian "ask" — which also blocked out-of-workspace reads, fetch, and a
  member's own command-based file reads (Codex reported it "couldn't read" in a live
  council). The council now runs **read-only** (`onAskPermission: "read-only"`):
  reads/search/think/fetch are auto-allowed so members can ground their answers,
  while writes and command execution are auto-denied. Still atomic (no suspend), and
  blocked writes/commands still surface in the council output.

- **Read-only client filesystem (`fs/read_text_file`).** Grok has a native
  file-read tool (auto-allowed), but Codex reads via its *shell* (kind `execute`),
  which read-only mode denies — so it still couldn't read in-council. Fix: the
  server now advertises the ACP client `fs.readTextFile` capability and serves
  reads itself, **sandboxed to the workspace** (or anywhere when
  `…_ALLOW_EXTERNAL_READS` is on). It does **not** advertise `writeTextFile`, so
  writes still go through the guardian. This gives every agent a guardian-scoped,
  non-shell read path — Codex can now read in the council (and everywhere) without a
  permit round-trip — while keeping the council genuinely read-only.

**Why.** The names now read by intent (`consult` = council; `ask_<member>` = one
voice), and the review tools work against any member without being mistaken for
council ops. Multi-round deliberation is opt-in so the cheap one-round panel stays
the default; using the existing CONSENSUS/OPEN verdict frame as the convergence
signal avoids a separate judge. Independent round 1 preserves the anti-anchoring
property ADR 0006/0007 valued, while later rounds give the genuine back-and-forth.

**Consequences.** Renamed tools break any saved muscle memory / scripts (`consult`
changes meaning; `ask_magi`/`reply` are gone). Multi-round `consult` is N×rounds
member turns — slow and token-heavy; raise `MCP_TOOL_TIMEOUT`. Stalemate detection
is a best-effort string-compare of verdict lines plus the hard round cap, not a
semantic judge. `review_diff member:"council"` can't run `git diff` (read-only mode
denies commands) — use single-advisor `review_diff` for that.
