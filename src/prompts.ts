/**
 * Prompt builders for each council tool.
 *
 * Members (GPT-5/Codex, Grok, Claude) respond best to compact, block-structured
 * prompts with stable XML tags: one task, an explicit output contract, and only
 * the grounding/verification blocks the task needs. These templates follow the
 * Codex prompting recipes and the GPT-5.2 prompting guide (default to tight
 * output, ground claims, label hypotheses, no speculative scope).
 *
 * Every builder takes `host` — the agent driving the council (Claude, Codex, or
 * Grok, whichever launched the MCP). The advisor is told it's reviewing for that
 * host, so the framing stays correct whoever is in the lead.
 */

/** Identity line for an advisor, framed for the current host. */
function preamble(name: string, host: string): string {
  return `You are ${name} acting as an independent peer reviewer and co-planner for ${host}, another AI coding agent working in this repository. Give a candid, technically specific second opinion. You can read the workspace to ground your answer. Disagree when warranted — your value is catching what ${host} missed, not agreeing.`;
}

/** How Codex names itself in prompts. */
const CODEX = "GPT-5/Codex";

const GROUNDING = `<grounding_rules>
Ground every claim in the repository or your own tool output. Do not present inferences as facts; label hypotheses as such. Prefer "based on <file>" over generic assertions.
</grounding_rules>`;

const MISSING_CONTEXT = `<missing_context_gating>
Do not guess missing repository facts. Read the relevant files to confirm. If something needed is genuinely unavailable, state exactly what remains unknown.
</missing_context_gating>`;

/** The short-debate frame, ending with a CONSENSUS/OPEN verdict line. */
function debate(host: string): string {
  return `<debate>
This is a short back-and-forth with ${host}, not a one-shot answer. ${host} may push back — engage the strongest version of its counter-argument. Concede the points it gets right and hold the ones you can defend, with reasons. Aim to converge on the best answer within ~3 exchanges.
End every reply with a final line, exactly one of:
VERDICT: CONSENSUS — <the agreed conclusion in one sentence>
VERDICT: OPEN — <the single most important point still unresolved>
</debate>`;
}

function assemble(name: string, host: string, ...blocks: string[]): string {
  return [preamble(name, host), ...blocks].join("\n\n");
}

function withContext(context: string | undefined): string {
  return context && context.trim().length > 0 ? `<context>\n${context.trim()}\n</context>` : "";
}

/** Shared block: a council turn is read-only deliberation, not a side-effect run. */
const DELIBERATION_ONLY = `<deliberation_only>
This is a READ-ONLY council deliberation. You MAY read any files and search/fetch to ground your view — read whatever you need directly (don't shell out for it). You may NOT modify files or run shell commands: writes and command execution are auto-declined here. Built-in web/X search is fine and encouraged where it helps. If something genuinely can't be inspected, say so briefly rather than trying to run a command.
</deliberation_only>`;

/** A focused question / second opinion on a specific decision, from Codex (the
 * `ask_codex` endpoint). Named for the member, not the `consult` council tool. */
export function askCodexPrompt(host: string, question: string, context?: string): string {
  return assemble(
    CODEX,
    host,
    `<task>\n${question.trim()}\n</task>`,
    withContext(context),
    `<compact_output_contract>\nAnswer directly first (≤3 sentences), then the key reasoning as a few bullets. If ${host}'s framing has a wrong assumption, say so up front. No preamble or recap.\n</compact_output_contract>`,
    GROUNDING,
    MISSING_CONTEXT,
    debate(host),
  );
}

/** Critique a plan/approach before the host implements it. */
export function reviewPlanPrompt(advisor: string, host: string, plan: string, context?: string): string {
  return assemble(
    advisor,
    host,
    `<task>\nReview this plan that ${host} intends to implement. Judge whether it is correct, complete, and the simplest approach that works.\n\n<plan>\n${plan.trim()}\n</plan>\n</task>`,
    withContext(context),
    `<structured_output_contract>\nReturn, highest-impact first:\n1. Verdict — sound / sound with changes / reconsider.\n2. Problems — concrete issues, each with why it matters and a fix. Ordered by severity.\n3. Blind spots — edge cases, failure modes, or simpler alternatives the plan ignores.\n4. Agreements — parts that are right (brief), so ${host} knows what to keep.\nBe specific; skip generic advice.\n</structured_output_contract>`,
    `<dig_deeper_nudge>\nAfter the first issue, check second-order effects: error paths, empty/initial state, concurrency, rollback, and whether a smaller design would do.\n</dig_deeper_nudge>`,
    GROUNDING,
    debate(host),
  );
}

/** Review concrete code changes (a diff or named paths). */
export function reviewDiffPrompt(
  advisor: string,
  host: string,
  opts: { diff?: string; paths?: string; instructions?: string },
): string {
  const target =
    opts.diff && opts.diff.trim().length > 0
      ? `Review the following diff:\n\n<diff>\n${opts.diff.trim()}\n</diff>`
      : opts.paths && opts.paths.trim().length > 0
        ? `Review the current changes. Focus on these paths: ${opts.paths.trim()}. Read them and, if available, inspect the working-tree diff with git.`
        : `Review the current uncommitted changes in this repository (inspect the working-tree diff with git, e.g. \`git diff\`).`;
  return assemble(
    advisor,
    host,
    `<task>\n${target}\n${opts.instructions ? `\nExtra focus: ${opts.instructions.trim()}\n` : ""}Find real correctness bugs, regressions, and gaps — not style nits.\n</task>`,
    `<structured_output_contract>\nReturn findings ordered by severity (blocker > major > minor). For each: file:line, what's wrong, why it matters, and the fix. If there are no real issues, say so plainly and note residual risk in one line. End with a one-line overall verdict.\n</structured_output_contract>`,
    `<dig_deeper_nudge>\nBeyond the obvious: empty-state and error paths, off-by-one and boundary conditions, stale/duplicated state, missing cleanup, and behavior changes that break callers.\n</dig_deeper_nudge>`,
    GROUNDING,
    MISSING_CONTEXT,
    debate(host),
  );
}

/** Open-ended co-design: generate alternative approaches to compare. */
export function brainstormPrompt(advisor: string, host: string, problem: string, constraints?: string): string {
  return assemble(
    advisor,
    host,
    `<task>\nPropose and compare approaches for this problem so ${host} can pick well:\n\n<problem>\n${problem.trim()}\n</problem>\n</task>`,
    constraints && constraints.trim().length > 0 ? `<constraints>\n${constraints.trim()}\n</constraints>` : "",
    `<research_mode>\nSeparate observed facts, reasoned inferences, and open questions. Go broad first, then deeper only where it changes the recommendation.\n</research_mode>`,
    `<compact_output_contract>\nGive 2–4 distinct approaches. For each: one-line summary, key trade-offs, and when to prefer it. End with a single recommendation and why. No filler.\n</compact_output_contract>`,
    GROUNDING,
    debate(host),
  );
}

/** A plain follow-up turn continuing the current debate on a member's live session. */
export function replyPrompt(host: string, message: string): string {
  return [
    `<reply>\n${message.trim()}\n</reply>`,
    `Continue the debate: respond to ${host}'s points directly, update your position where warranted, and keep grounding claims in the repository.`,
    debate(host),
  ].join("\n\n");
}

/** Initial exploration: map an unfamiliar codebase. */
export function explorePrompt(advisor: string, host: string, focus?: string, paths?: string): string {
  const scope =
    focus && focus.trim().length > 0
      ? `Focus the exploration on: ${focus.trim()}.`
      : `Map the overall structure of this repository.`;
  return assemble(
    advisor,
    host,
    `<task>\n${scope}${paths ? ` Start from: ${paths.trim()}.` : ""} Read the code to understand how it actually works — entry points, the main modules and how they fit together, key data types/flows, and notable conventions.\n</task>`,
    `<tool_persistence_rules>\nKeep reading until you can describe the system confidently. Don't stop after a partial read when one more targeted look would sharpen the map.\n</tool_persistence_rules>`,
    `<research_mode>\nBreadth first (the shape of the whole), then depth on the parts that matter for the focus. Separate what you observed from what you're inferring.\n</research_mode>`,
    `<compact_output_contract>\nReturn: a 2–3 sentence overview; the key components with their responsibilities and where they live (paths); the main data/control flow; and gotchas or conventions worth knowing. Reference real files. No filler.\n</compact_output_contract>`,
    MISSING_CONTEXT,
  );
}

/** Grok's extra capabilities, advertised so it leans on them when relevant. */
const GROK_STRENGTHS = `<grok_strengths>
You have live web and X (Twitter) search, current-events knowledge, and image/video generation. Lean on these when the question benefits from real-time information, an X/web lookup, or generated media. Cite sources when you searched.
</grok_strengths>`;

/** Council variant: search is in-bounds, but generation goes through its own tool. */
const GROK_STRENGTHS_COUNCIL = `<grok_strengths>
You have live web and X (Twitter) search and current-events knowledge — use them to ground or adjudicate. You can also generate images and video, but not during this deliberation; if media would settle the question, say so and the host will invoke it separately.
</grok_strengths>`;

/** A direct second opinion from Grok (the `ask_grok` endpoint). */
export function askGrokPrompt(host: string, question: string, context?: string): string {
  return assemble(
    "Grok",
    host,
    `<task>\n${question.trim()}\n</task>`,
    withContext(context),
    GROK_STRENGTHS,
    `<compact_output_contract>\nAnswer directly first (≤3 sentences), then the key reasoning as a few bullets. If ${host}'s framing has a wrong assumption, say so up front. No preamble or recap.\n</compact_output_contract>`,
    GROUNDING,
    debate(host),
  );
}

/** A direct second opinion from Claude (the `ask_claude` endpoint — for non-Claude hosts). */
export function askClaudePrompt(host: string, question: string, context?: string): string {
  return assemble(
    "Claude",
    host,
    `<task>\n${question.trim()}\n</task>`,
    withContext(context),
    `<compact_output_contract>\nAnswer directly first (≤3 sentences), then the key reasoning as a few bullets. If ${host}'s framing has a wrong assumption, say so up front. No preamble or recap.\n</compact_output_contract>`,
    GROUNDING,
    MISSING_CONTEXT,
    debate(host),
  );
}

/** The shared framing for a Magi-council turn: who is in the room. */
function magiFrame(host: string, fellows?: string[]): string {
  const others = fellows && fellows.length > 0 ? ` Your fellow advisors this round: ${fellows.join(", ")}.` : "";
  return `<magi_council>
This is the Magi council: ${host} (the lead — convened this and will synthesize the voices) and its advisors.${others} You are one independent advisor. Give your own candid view; ${host} reconciles, so don't water it down to agree.
</magi_council>`;
}

/**
 * One advisor's turn in the Magi council. All active members are equal advisors
 * and answer the same question independently; `grokStrengths` adds Grok's
 * live-search note when the advisor is Grok.
 */
export function magiAdvisorPrompt(opts: {
  advisor: string;
  host: string;
  question: string;
  context?: string;
  hostTake?: string;
  fellowAdvisors?: string[];
  grokStrengths?: boolean;
}): string {
  return assemble(
    opts.advisor,
    opts.host,
    magiFrame(opts.host, opts.fellowAdvisors),
    `<question>\n${opts.question.trim()}\n</question>`,
    withContext(opts.context),
    opts.hostTake && opts.hostTake.trim().length > 0 ? `<host_position>\n${opts.hostTake.trim()}\n</host_position>` : "",
    opts.grokStrengths ? GROK_STRENGTHS_COUNCIL : "",
    DELIBERATION_ONLY,
    `<compact_output_contract>\nYour position in ≤4 sentences, then up to ~4 bullets of key reasoning, risks, or where you'd push back on the host. No preamble.\n</compact_output_contract>`,
    GROUNDING,
  );
}

/**
 * A later deliberation round: the advisor sees every advisor's previous-round
 * position and responds — engaging the others, updating where warranted, and
 * ending with a `CHANGED:` line (did its position move?) and a CONSENSUS/OPEN
 * verdict. The council loop reads both to detect when the debate has settled (all
 * CONSENSUS) or stalled (no one moved).
 */
export function magiDeliberatePrompt(opts: {
  advisor: string;
  host: string;
  question: string;
  context?: string;
  hostTake?: string;
  priorPositions: Array<{ name: string; text: string }>;
  round: number;
  maxRounds: number;
  grokStrengths?: boolean;
}): string {
  const positions = opts.priorPositions
    .map((p) => `### ${p.name}\n${p.text.trim() || "(no usable answer)"}`)
    .join("\n\n");
  const fellows = opts.priorPositions.map((p) => p.name).filter((n) => n !== opts.advisor);
  return assemble(
    opts.advisor,
    opts.host,
    magiFrame(opts.host, fellows),
    `<deliberation_round>\nThis is round ${opts.round} of up to ${opts.maxRounds}. Below are every advisor's positions from the previous round (including your own). Engage the others directly: say where you agree, where you disagree and why, and update your own view if they've changed your mind. Converge if you honestly can; hold your ground with reasons if you can't.\n</deliberation_round>`,
    `<question>\n${opts.question.trim()}\n</question>`,
    withContext(opts.context),
    opts.hostTake && opts.hostTake.trim().length > 0 ? `<host_position>\n${opts.hostTake.trim()}\n</host_position>` : "",
    `<previous_round>\n${positions}\n</previous_round>`,
    opts.grokStrengths ? GROK_STRENGTHS_COUNCIL : "",
    DELIBERATION_ONLY,
    `<output_contract>\nRespond in ≤4 sentences, then up to ~4 bullets engaging the other advisors. Then end with EXACTLY these two final lines:\nCHANGED: <YES if your position moved from your previous-round answer, otherwise NO>\nVERDICT: CONSENSUS — <the one-sentence conclusion you now share with the council>  (or)  VERDICT: OPEN — <the single most important point still unresolved>\n</output_contract>`,
    GROUNDING,
  );
}

/**
 * Ask Grok to generate an image or short video and save it into the workspace
 * (the `grok_generate` tool). Not a reviewer turn — it produces media, then
 * reports the path(s) so the host can surface the file.
 */
export function grokGeneratePrompt(prompt: string, kind: "image" | "video", outputPath?: string): string {
  const what = kind === "video" ? "a short video" : "an image";
  return [
    `You are Grok (xAI), generating media for the host agent working in this repository.`,
    `<task>\nGenerate ${what} from this description using your built-in ${kind} generation, then save the result into the workspace:\n\n<description>\n${prompt.trim()}\n</description>\n</task>`,
    outputPath && outputPath.trim().length > 0
      ? `<output>\nSave it to: ${outputPath.trim()} (relative to the workspace).\n</output>`
      : `<output>\nSave it under the workspace (e.g. ./generated/) with a short descriptive filename.\n</output>`,
    `<report>\nWhen it is saved, reply with ONLY the file path(s) you wrote and a one-line caption — no preamble. If you cannot save to disk, say so plainly and include any link you produced.\n</report>`,
  ].join("\n\n");
}
