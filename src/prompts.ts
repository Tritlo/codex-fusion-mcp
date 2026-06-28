/**
 * Prompt builders for each fusion tool.
 *
 * Coding agents tend to behave best with compact, block-structured prompts with
 * stable XML tags: one task, an explicit output contract, and only the
 * grounding/verification blocks the task needs. These templates follow the
 * Codex prompting recipes and the GPT-5.2 prompting guide as a baseline (default to tight
 * output, ground claims, label hypotheses, no speculative scope).
 */

function preamble(agentName: string): string {
  return `You are ${agentName} acting as an independent peer reviewer and co-planner for Claude, another AI coding agent working in this repository. Give a candid, technically specific second opinion. You can read the workspace to ground your answer. Disagree when warranted — your value is catching what Claude missed, not agreeing.`;
}

const GROUNDING = `<grounding_rules>
Ground every claim in the repository or your own tool output. Do not present inferences as facts; label hypotheses as such. Prefer "based on <file>" over generic assertions.
</grounding_rules>`;

const MISSING_CONTEXT = `<missing_context_gating>
Do not guess missing repository facts. Read the relevant files to confirm. If something needed is genuinely unavailable, state exactly what remains unknown.
</missing_context_gating>`;

const DEBATE = `<debate>
This is a short back-and-forth with Claude, not a one-shot answer. Claude may push back — engage the strongest version of its counter-argument. Concede the points it gets right and hold the ones you can defend, with reasons. Aim to converge on the best answer within ~3 exchanges.
End every reply with a final line, exactly one of:
VERDICT: CONSENSUS — <the agreed conclusion in one sentence>
VERDICT: OPEN — <the single most important point still unresolved>
</debate>`;

function assemble(agentName: string, ...blocks: string[]): string {
  return [preamble(agentName), ...blocks].join("\n\n");
}

function withContext(context: string | undefined): string {
  return context && context.trim().length > 0
    ? `<context>\n${context.trim()}\n</context>`
    : "";
}

/** A focused question / second opinion on a specific decision. */
export function consultPrompt(agentName: string, question: string, context?: string): string {
  return assemble(
    agentName,
    `<task>\n${question.trim()}\n</task>`,
    withContext(context),
    `<compact_output_contract>\nAnswer directly first (≤3 sentences), then the key reasoning as a few bullets. If Claude's framing has a wrong assumption, say so up front. No preamble or recap.\n</compact_output_contract>`,
    GROUNDING,
    MISSING_CONTEXT,
    DEBATE,
  );
}

/** Critique a plan/approach before Claude implements it. */
export function reviewPlanPrompt(agentName: string, plan: string, context?: string): string {
  return assemble(
    agentName,
    `<task>\nReview this plan that Claude intends to implement. Judge whether it is correct, complete, and the simplest approach that works.\n\n<plan>\n${plan.trim()}\n</plan>\n</task>`,
    withContext(context),
    `<structured_output_contract>\nReturn, highest-impact first:\n1. Verdict — sound / sound with changes / reconsider.\n2. Problems — concrete issues, each with why it matters and a fix. Ordered by severity.\n3. Blind spots — edge cases, failure modes, or simpler alternatives the plan ignores.\n4. Agreements — parts that are right (brief), so Claude knows what to keep.\nBe specific; skip generic advice.\n</structured_output_contract>`,
    `<dig_deeper_nudge>\nAfter the first issue, check second-order effects: error paths, empty/initial state, concurrency, rollback, and whether a smaller design would do.\n</dig_deeper_nudge>`,
    GROUNDING,
    DEBATE,
  );
}

/** Review concrete code changes (a diff or named paths). */
export function reviewDiffPrompt(
  agentName: string,
  opts: { diff?: string; paths?: string; instructions?: string },
): string {
  const target = opts.diff && opts.diff.trim().length > 0
    ? `Review the following diff:\n\n<diff>\n${opts.diff.trim()}\n</diff>`
    : opts.paths && opts.paths.trim().length > 0
      ? `Review the current changes. Focus on these paths: ${opts.paths.trim()}. Read them and, if available, inspect the working-tree diff with git.`
      : `Review the current uncommitted changes in this repository (inspect the working-tree diff with git, e.g. \`git diff\`).`;
  return assemble(
    agentName,
    `<task>\n${target}\n${opts.instructions ? `\nExtra focus: ${opts.instructions.trim()}\n` : ""}Find real correctness bugs, regressions, and gaps — not style nits.\n</task>`,
    `<structured_output_contract>\nReturn findings ordered by severity (blocker > major > minor). For each: file:line, what's wrong, why it matters, and the fix. If there are no real issues, say so plainly and note residual risk in one line. End with a one-line overall verdict.\n</structured_output_contract>`,
    `<dig_deeper_nudge>\nBeyond the obvious: empty-state and error paths, off-by-one and boundary conditions, stale/duplicated state, missing cleanup, and behavior changes that break callers.\n</dig_deeper_nudge>`,
    GROUNDING,
    MISSING_CONTEXT,
    DEBATE,
  );
}

/** Open-ended co-design: generate alternative approaches to compare. */
export function brainstormPrompt(agentName: string, problem: string, constraints?: string): string {
  return assemble(
    agentName,
    `<task>\nPropose and compare approaches for this problem so Claude can pick well:\n\n<problem>\n${problem.trim()}\n</problem>\n</task>`,
    constraints && constraints.trim().length > 0
      ? `<constraints>\n${constraints.trim()}\n</constraints>`
      : "",
    `<research_mode>\nSeparate observed facts, reasoned inferences, and open questions. Go broad first, then deeper only where it changes the recommendation.\n</research_mode>`,
    `<compact_output_contract>\nGive 2–4 distinct approaches. For each: one-line summary, key trade-offs, and when to prefer it. End with a single recommendation and why. No filler.\n</compact_output_contract>`,
    GROUNDING,
    DEBATE,
  );
}

/** A plain follow-up turn continuing the current debate on the live session. */
export function replyPrompt(message: string): string {
  return [
    `<reply>\n${message.trim()}\n</reply>`,
    `Continue the debate: respond to Claude's points directly, update your position where warranted, and keep grounding claims in the repository.`,
    DEBATE,
  ].join("\n\n");
}

/** Initial exploration: map an unfamiliar codebase. */
export function explorePrompt(agentName: string, focus?: string, paths?: string): string {
  const scope = focus && focus.trim().length > 0
    ? `Focus the exploration on: ${focus.trim()}.`
    : `Map the overall structure of this repository.`;
  return assemble(
    agentName,
    `<task>\n${scope}${paths ? ` Start from: ${paths.trim()}.` : ""} Read the code to understand how it actually works — entry points, the main modules and how they fit together, key data types/flows, and notable conventions.\n</task>`,
    `<tool_persistence_rules>\nKeep reading until you can describe the system confidently. Don't stop after a partial read when one more targeted look would sharpen the map.\n</tool_persistence_rules>`,
    `<research_mode>\nBreadth first (the shape of the whole), then depth on the parts that matter for the focus. Separate what you observed from what you're inferring.\n</research_mode>`,
    `<compact_output_contract>\nReturn: a 2–3 sentence overview; the key components with their responsibilities and where they live (paths); the main data/control flow; and gotchas or conventions worth knowing. Reference real files. No filler.\n</compact_output_contract>`,
    MISSING_CONTEXT,
  );
}
