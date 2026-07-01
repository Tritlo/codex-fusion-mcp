# 0011 — Council memory in a workspace `MAGI.md` (proposed)

**Status:** Proposed — not implemented. Captured so the trade-off is on record.

**Context.** The council's accumulated context lives only inside the advisor ACP
sessions: opaque, in-process, and asymmetric with the host. After a host `/clear`
(handled by the nonce hook, ADR 0004), a server crash/respawn, a reboot, or a host
**resume**, advisors start empty while the host still remembers — so a follow-up can
land on an advisor that has lost the thread (README, *Sessions & reset*). ADR 0010
added a `fresh` flag to deliberately *forget* per consult, but there is still no
durable, inspectable council memory. The recursive self-review surfaced the two ends
of the "how much should advisors remember across calls?" axis:

- **Grok:** make council memory *first-class* — a git-trackable file the council
  reads at the start of a turn and appends to at the end.
- **Codex:** go the other way — ephemeral sessions for genuine independence. That
  end is now the `fresh` flag (ADR 0010).

This ADR records the first proposal.

**Proposal.** An optional workspace council-memory file — e.g. `.magi/council-notes.md`
(or `MAGI.md`) — as an explicit, durable, host-editable record of what the council
has concluded:

- On a council/`ask` turn, the advisor reads the latest notes first (via the
  existing read-only `fs/read_text_file` path).
- At the end, the advisor may propose a short structured append (decision / open
  questions / verdict). That's a **write**, so it goes through the guardian (a
  `permit`, or auto under a dedicated opt-in).
- ACP session persistence becomes a speed/cache layer; the file is the source of
  truth, so it survives `/clear`, respawn, reboot, and the host-resume asymmetry,
  and the host can edit or prune it.

**Options considered.**

- **A. Status quo** — opaque ACP sessions + nonce reset + the `fresh` flag.
  Simplest, no new surface; but memory is invisible, un-editable, and lost on
  respawn.
- **B. `MAGI.md` council memory** (this proposal). Durable, inspectable,
  git-trackable; makes recursive self-improvement literal (the council can edit its
  own memory). Costs: prompt bloat (every turn reads it), write-permit friction,
  file growth/curation, and a sanctioned write carve-out in the otherwise read-only
  council mode.
- **C. Server-managed memory** — the server summarizes and re-injects context, no
  file. Keeps the read-only model clean but reintroduces opaque, non-git memory plus
  a summarization step that's easy to get wrong.

**Recommendation: defer.** If adopted, land it behind an explicit opt-in (off by
default). The `fresh` flag (ADR 0010) and the nonce reset already cover the common
cases, and B adds real, recurring cost (prompt size, permit friction, curation) for
a benefit that mainly shows up across respawns/reboots. Revisit when the
resume-asymmetry actually bites, or when running the council for long-horizon
self-improvement where a durable shared scratchpad clearly pays off.

**Consequences.** *If adopted:* a documented file convention; every council turn's
prompt grows by the notes; the read-only invariant gains one sanctioned write path;
the host owns curation. *If not:* advisors stay forgetful across respawns — rely on
re-establishing context or `reset`.
