#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig, MEMBER_IDS, type MemberId, type MemberSpec } from "./config.ts";
import { selectCouncil } from "./council.ts";
import {
  AcpSession,
  NoPendingPermission,
  type AskOptions,
  type AskResult,
  type SessionStatus,
  type TurnOutcome,
} from "./session.ts";
import {
  askClaudePrompt,
  askCodexPrompt,
  askGrokPrompt,
  brainstormPrompt,
  explorePrompt,
  grokGeneratePrompt,
  magiAdvisorPrompt,
  replyPrompt,
  reviewDiffPrompt,
  reviewPlanPrompt,
} from "./prompts.ts";

// The ACP agents (esp. Grok) emit `_x.ai/*` extension notifications and stray
// responses the ACP SDK can't route; it logs each via console.error as "Error
// handling notification" / "Got response to unknown request". They're harmless
// protocol cross-talk but spam the MCP logs, so drop just those lines and pass
// everything else through.
const ACP_NOISE = ["Error handling notification", "Got response to unknown request"];
const baseConsoleError = console.error.bind(console);
console.error = ((...args: unknown[]): void => {
  if (typeof args[0] === "string" && ACP_NOISE.some((p) => (args[0] as string).startsWith(p))) return;
  baseConsoleError(...args);
}) as typeof console.error;

const config = loadConfig();
const specs: Record<MemberId, MemberSpec> = { claude: config.claude, codex: config.codex, grok: config.grok };
const sessions: Record<MemberId, AcpSession> = {
  claude: new AcpSession(config, config.claude),
  codex: new AcpSession(config, config.codex),
  grok: new AcpSession(config, config.grok),
};

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ToolResult = { content: Array<{ type: "text"; text: string }> };

// --- host resolution ------------------------------------------------------
// The agent driving the MCP (the client) is the council host and is excluded
// from its own council. Resolution order: MAGI_COUNCIL_EXCLUDE (startup) >
// clientInfo regex > unknown (exclude nobody — all three participate, and one
// may be the host). The `source` is surfaced so an unrecognized host knows it can
// set the env var to exclude itself (see status / ask_magi warning).

type HostSource = "env" | "clientInfo" | "unknown";
interface HostResolution {
  /** Member excluded as the host, or undefined when the host is unknown. */
  excluded?: MemberId;
  source: HostSource;
  rawClient?: string;
}
let resolved: HostResolution | undefined;

function detectFromClientInfo(name: string | undefined): MemberId | undefined {
  if (!name) return undefined;
  if (/claude/i.test(name)) return "claude";
  if (/codex/i.test(name)) return "codex";
  if (/grok/i.test(name)) return "grok";
  return undefined;
}

function resolveHost(): HostResolution {
  if (resolved) return resolved;
  const rawClient = server.server.getClientVersion()?.name;
  if (config.excludeOverride) {
    resolved = { excluded: config.excludeOverride, source: "env", rawClient };
  } else {
    const detected = detectFromClientInfo(rawClient);
    resolved = detected ? { excluded: detected, source: "clientInfo", rawClient } : { source: "unknown", rawClient };
  }
  return resolved;
}

const isActive = (id: MemberId): boolean => resolveHost().excluded !== id;
const activeIds = (): MemberId[] => MEMBER_IDS.filter(isActive);
/** The host's display name for prompt framing (generic when the host is unknown). */
const hostName = (): string => {
  const e = resolveHost().excluded;
  return e ? specs[e].name : "the host agent";
};

/**
 * Resolve which advisor a per-member deliberative tool targets: the requested
 * member if active, else (when none requested) Codex, else the first active
 * advisor. Returns undefined only when a specific inactive member was requested.
 */
function advisorFor(member: MemberId | undefined): MemberId | undefined {
  if (member) return isActive(member) ? member : undefined;
  return isActive("codex") ? "codex" : activeIds()[0];
}

const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

/** One-line footer for a finished turn: latency, and tokens when reported. */
function footer(result: AskResult): string {
  const parts = [`${(result.ms / 1000).toFixed(1)}s`];
  if (result.usage) parts.push(`${fmtTokens(result.usage.totalTokens)} tok`);
  return `_${parts.join(" · ")}_`;
}

/** Render a finished turn: the member's answer, then a terse one-line footer. */
function renderAnswer(result: AskResult, name: string): ToolResult {
  const body = result.text.length > 0 ? result.text : `_(${name} returned no text)_`;
  const stop =
    result.stopReason === "end_turn"
      ? ""
      : result.stopReason === "timeout"
        ? `\n\n_(${name} went silent — pass a larger \`time\` (seconds) to extend the idle timeout, or narrow the question)_`
        : result.stopReason === "cancelled"
          ? "\n\n_(cancelled)_"
          : `\n\n_(${name} stopped: ${result.stopReason})_`;
  return { content: [{ type: "text", text: `${body}${stop}\n\n${footer(result)}` }] };
}

/** Render whatever a turn produced: an answer, or a permission for the host to judge. */
function renderOutcome(outcome: TurnOutcome, name: string): ToolResult {
  if (outcome.type === "permission") {
    return {
      content: [
        {
          type: "text",
          text:
            `🔐 ${name} paused and needs your permission to continue:\n\n` +
            `    ${outcome.description}\n\n` +
            `Decide whether this is reasonable, then call **permit** with decision \`allow\` or \`deny\` ` +
            `(member \`${name.toLowerCase()}\`) to resume the turn — ${name} is waiting on the same session.`,
        },
      ],
    };
  }
  return renderAnswer(outcome.result, name);
}

/** Turn a thrown member error into a readable result, flagging likely out-of-usage. */
function renderMemberError(name: string, err: unknown, loginHint?: string): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  const outOfUsage =
    /quota|rate.?limit|\b429\b|too many requests|credit|insufficient|usage limit|out of (usage|credit)|over[ -]?(the )?limit|payment|billing|exhaust/i.test(
      msg,
    );
  const head = outOfUsage
    ? `⚠️ ${name} looks out of usage / over its quota right now.`
    : `⚠️ ${name} couldn't complete the request.`;
  // Append the recovery hint for usage failures, unless the message already has it
  // (startup errors build it in; turn-time failures don't).
  const hint = outOfUsage && loginHint && !msg.includes(loginHint) ? `\n\nTo recover: ${loginHint}.` : "";
  return { content: [{ type: "text", text: `${head}\n\n${msg}${hint}` }] };
}

/** Result for a direct tool whose member is the host (excluded from the council). */
function inactiveResult(id: MemberId): ToolResult {
  const how = resolveHost().source === "env" ? "set by MAGI_COUNCIL_EXCLUDE" : "detected as the host";
  return {
    content: [
      {
        type: "text",
        text: `${specs[id].name} is the council host (${how}) and can't advise itself. Active council: ${activeIds()
          .map((i) => specs[i].name)
          .join(", ")}.`,
      },
    ],
  };
}

/** Last line / tail of the streamed text so far, for a rolling live view. */
const tail = (s: string): string => s.replace(/\s+/g, " ").trim().slice(-140);

type Notify = (message: string) => void;

/** A single monotonic progress channel for one MCP tool call. Concurrent council
 * advisors must share *one* of these — MCP progress values are per-token and
 * should increase, so a per-advisor counter would emit duplicate/out-of-order
 * `progress` numbers on the same token. */
function progressNotifier(extra: Extra): Notify {
  const token = extra._meta?.progressToken;
  let progress = 0;
  return (message: string): void => {
    if (token === undefined) return;
    void extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress: ++progress, message },
    });
  };
}

/** Streaming hooks that forward a member's output via a (possibly shared) notifier. */
function streamHooks(notify: Notify, prefix = ""): Pick<AskOptions, "onText" | "onThought" | "onActivity"> {
  let acc = "";
  let thinking = "";
  return {
    onText: (chunk) => {
      acc += chunk;
      notify(`${prefix}${tail(acc)}`);
    },
    onThought: (chunk) => {
      thinking += chunk;
      notify(`${prefix}💭 ${tail(thinking)}`);
    },
    onActivity: (note) => notify(`${prefix}↳ ${note}`),
  };
}

/** Start a member turn, streaming progress, honouring cancellation, and reporting errors. */
function ask(id: MemberId, prompt: string, extra: Extra, label: string, time?: number): Promise<ToolResult> {
  const session = sessions[id];
  const timeoutMs = time !== undefined ? time * 1000 : undefined;
  return session
    .ask(prompt, { label, signal: extra.signal, timeoutMs, ...streamHooks(progressNotifier(extra)) })
    .then((outcome) => renderOutcome(outcome, session.name))
    .catch((err: unknown) => renderMemberError(session.name, err, session.loginHint));
}

/**
 * Optional per-call override of the idle timeout, in seconds. The clock is
 * measured from the member's last output, so an actively-working turn is never
 * cut off; raise this only for big reviews/explorations (or media generation)
 * that may pause for long stretches before producing more output.
 */
const timeField = {
  time: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional idle timeout in seconds for this call, overriding the default. The clock runs from the member's last output, so a turn that keeps streaming is never cut off — raise this for large reviews/explorations or media generation that may go quiet for a while.",
    ),
};

const server = new McpServer({ name: "magi-council", version: "0.1.0" });

// Tool handles per member, so the host's direct tools can be removed once known.
const memberTools: Record<MemberId, Array<{ remove(): void }>> = { claude: [], codex: [], grok: [] };

// --- Codex tools ----------------------------------------------------------

memberTools.codex.push(
  server.registerTool(
    "ask_codex",
    {
      description:
        "Ask Codex (GPT-5) directly for an independent second opinion on a specific question or decision. Codex debates back; continue with `codex_reply` (cap ~3 turns). For the whole council use `consult`.",
      inputSchema: {
        question: z.string().describe("The specific question or decision to put to Codex."),
        context: z
          .string()
          .optional()
          .describe("Optional background: your current thinking, constraints, or relevant snippets."),
        ...timeField,
      },
    },
    ({ question, context, time }, extra) =>
      isActive("codex")
        ? ask("codex", askCodexPrompt(hostName(), question, context), extra, "ask_codex", time)
        : inactiveResult("codex"),
  ),
);

memberTools.codex.push(
  server.registerTool(
    "codex_reply",
    {
      description:
        "Continue the conversation with Codex on the SAME session (it remembers the thread). Push back on its last answer and drive toward consensus — keep the whole debate to ~3 turns.",
      inputSchema: {
        message: z.string().describe("Your rebuttal, counter-point, or follow-up question for Codex."),
        ...timeField,
      },
    },
    ({ message, time }, extra) =>
      isActive("codex")
        ? ask("codex", replyPrompt(hostName(), message), extra, "codex_reply", time)
        : inactiveResult("codex"),
  ),
);

// --- Claude tools (only when some OTHER agent is the host) -----------------

memberTools.claude.push(
  server.registerTool(
    "ask_claude",
    {
      description:
        "Ask Claude (Anthropic) directly for an independent second opinion — a strong generalist coder's take. Continue with `claude_reply`. (Available only when the host is not Claude.)",
      inputSchema: {
        question: z.string().describe("The specific question or decision to put to Claude."),
        context: z.string().optional().describe("Optional background, constraints, or relevant snippets."),
        ...timeField,
      },
    },
    ({ question, context, time }, extra) =>
      isActive("claude")
        ? ask("claude", askClaudePrompt(hostName(), question, context), extra, "ask_claude", time)
        : inactiveResult("claude"),
  ),
);

memberTools.claude.push(
  server.registerTool(
    "claude_reply",
    {
      description:
        "Continue the conversation with Claude on the SAME session (it remembers the thread). Use to push back on or follow up Claude's last answer.",
      inputSchema: {
        message: z.string().describe("Your rebuttal, counter-point, or follow-up question for Claude."),
        ...timeField,
      },
    },
    ({ message, time }, extra) =>
      isActive("claude")
        ? ask("claude", replyPrompt(hostName(), message), extra, "claude_reply", time)
        : inactiveResult("claude"),
  ),
);

// --- Grok tools -----------------------------------------------------------

memberTools.grok.push(
  server.registerTool(
    "ask_grok",
    {
      description:
        "Ask Grok (xAI) directly — an independent second opinion with live web and X (Twitter) search, current-events knowledge, and image/video generation. Reach for it when the question needs real-time info, an X/web lookup, or a different model's take; for generated media use `grok_generate`. Grok continues the thread; follow up with `grok_reply`.",
      inputSchema: {
        question: z.string().describe("The specific question or task to put to Grok."),
        context: z.string().optional().describe("Optional background, constraints, or relevant snippets."),
        ...timeField,
      },
    },
    ({ question, context, time }, extra) =>
      isActive("grok")
        ? ask("grok", askGrokPrompt(hostName(), question, context), extra, "ask_grok", time)
        : inactiveResult("grok"),
  ),
);

memberTools.grok.push(
  server.registerTool(
    "grok_reply",
    {
      description:
        "Continue the conversation with Grok on the SAME session (it remembers the thread). Use to push back on or follow up Grok's last answer.",
      inputSchema: {
        message: z.string().describe("Your rebuttal, counter-point, or follow-up question for Grok."),
        ...timeField,
      },
    },
    ({ message, time }, extra) =>
      isActive("grok") ? ask("grok", replyPrompt(hostName(), message), extra, "grok_reply", time) : inactiveResult("grok"),
  ),
);

memberTools.grok.push(
  server.registerTool(
    "grok_generate",
    {
      description:
        "Generate an image or short video with Grok (xAI) and save it into the workspace — diagrams, mockups, illustrations, or short clips. Saving the file needs a write permission, so this usually pauses with a 🔐 — approve it with `permit` to let Grok write the result. Media generation (video especially) is heavier and slower than text.",
      inputSchema: {
        prompt: z.string().describe("What to generate — a detailed description of the image or video."),
        kind: z
          .enum(["image", "video"])
          .optional()
          .describe("Media type. Defaults to image. Video is slower and costs more usage."),
        output_path: z
          .string()
          .optional()
          .describe("Optional path/filename to save to (relative to the workspace). Omit to let Grok choose."),
        ...timeField,
      },
    },
    ({ prompt, kind, output_path, time }, extra) =>
      isActive("grok")
        ? ask("grok", grokGeneratePrompt(prompt, kind ?? "image", output_path), extra, "grok_generate", time)
        : inactiveResult("grok"),
  ),
);

// --- Deliberative tools (one advisor; default Codex) ----------------------
// Structured single-advisor passes. They take an optional `member` (default
// Codex, or the first active advisor if Codex is the host), so they work against
// any council member — always registered, not tied to one member's host status.

const memberField = {
  member: z
    .enum(["claude", "codex", "grok", "council"])
    .optional()
    .describe(
      'Which advisor to ask: a specific member, or "council" to fan out to all active advisors (each gives an independent view). Defaults to Codex (or the first available advisor if Codex is the host).',
    ),
};

server.registerTool(
  "review_plan",
  {
    description:
      "Have an advisor critique a plan or approach BEFORE you implement it — verdict, problems by severity, blind spots, and what to keep. Defaults to Codex; continue with that advisor's reply tool.",
    inputSchema: {
      plan: z.string().describe("The plan/approach to review (steps, design, or intended changes)."),
      context: z.string().optional().describe("Optional background or constraints."),
      ...memberField,
      ...timeField,
    },
  },
  ({ plan, context, member, time }, extra) => {
    const build = (id: MemberId): string => reviewPlanPrompt(specs[id].promptName, hostName(), plan, context);
    if (member === "council") return councilFanOut("review_plan", build, extra, time !== undefined ? time * 1000 : undefined);
    const target = advisorFor(member);
    if (!target) return inactiveResult(member!);
    return ask(target, build(target), extra, "review_plan", time);
  },
);

server.registerTool(
  "review_diff",
  {
    description:
      "Have an advisor review code changes for correctness bugs and gaps. Pass a diff, or name paths and let the advisor read the working tree (it may ask permission to run `git diff`). Defaults to Codex.",
    inputSchema: {
      diff: z.string().optional().describe("A unified diff to review. Omit to let the advisor inspect `git diff` itself."),
      paths: z.string().optional().describe("Paths to focus on (used when no diff is supplied)."),
      instructions: z.string().optional().describe("Optional extra focus for the review."),
      ...memberField,
      ...timeField,
    },
  },
  ({ diff, paths, instructions, member, time }, extra) => {
    const build = (id: MemberId): string => reviewDiffPrompt(specs[id].promptName, hostName(), { diff, paths, instructions });
    if (member === "council") {
      // Council mode is read-only — it can't run `git diff`. Without an explicit
      // diff the advisors would have nothing to review, so refuse early rather
      // than fan out to a guaranteed "I couldn't inspect the changes".
      if (!diff || diff.trim().length === 0) {
        return {
          content: [
            {
              type: "text",
              text: 'review_diff with `member: "council"` needs an explicit `diff`: council mode is read-only and can\'t run `git diff`. Pass a diff, or use single-advisor review_diff (default Codex), which can run `git diff` via a permit.',
            },
          ],
        };
      }
      return councilFanOut("review_diff", build, extra, time !== undefined ? time * 1000 : undefined);
    }
    const target = advisorFor(member);
    if (!target) return inactiveResult(member!);
    return ask(target, build(target), extra, "review_diff", time);
  },
);

server.registerTool(
  "brainstorm",
  {
    description:
      "Co-design with an advisor: get 2–4 alternative approaches with trade-offs and a recommendation, to compare against your own. Defaults to Codex.",
    inputSchema: {
      problem: z.string().describe("The design problem to explore."),
      constraints: z.string().optional().describe("Optional constraints, requirements, or non-goals."),
      ...memberField,
      ...timeField,
    },
  },
  ({ problem, constraints, member, time }, extra) => {
    const build = (id: MemberId): string => brainstormPrompt(specs[id].promptName, hostName(), problem, constraints);
    if (member === "council") return councilFanOut("brainstorm", build, extra, time !== undefined ? time * 1000 : undefined);
    const target = advisorFor(member);
    if (!target) return inactiveResult(member!);
    return ask(target, build(target), extra, "brainstorm", time);
  },
);

server.registerTool(
  "explore",
  {
    description:
      "Have an advisor explore an unfamiliar codebase and report its structure, key components, data/control flow, and conventions. Good for initial orientation. Defaults to Codex.",
    inputSchema: {
      focus: z.string().optional().describe("What to focus the exploration on (a feature, subsystem, or question)."),
      paths: z.string().optional().describe("Optional starting paths."),
      ...memberField,
      ...timeField,
    },
  },
  ({ focus, paths, member, time }, extra) => {
    const build = (id: MemberId): string => explorePrompt(specs[id].promptName, hostName(), focus, paths);
    if (member === "council") return councilFanOut("explore", build, extra, time !== undefined ? time * 1000 : undefined);
    const target = advisorFor(member);
    if (!target) return inactiveResult(member!);
    return ask(target, build(target), extra, "explore", time);
  },
);

// --- The Magi council -----------------------------------------------------

server.registerTool(
  "consult",
  {
    description:
      "Consult the Magi council — every active advisor (the council members other than you) gives an independent view in one round, and you synthesize. Deliberation is host-mediated: it returns after one round; to make the council deliberate, weigh in and **call `consult` again** with `my_take` set to your evolving position (the advisors keep their context and respond to you), iterating until you judge agreement is reached. For one specific advisor use `ask_codex`/`ask_grok`/`ask_claude`; for a structured single-advisor pass use `review_plan`/`review_diff`/`brainstorm`/`explore` (those take `member: \"council\"` to fan out to all).",
    inputSchema: {
      question: z.string().describe("The question or decision to put to the council."),
      context: z.string().optional().describe("Optional background or constraints."),
      my_take: z
        .string()
        .optional()
        .describe(
          "Your own current position, put before the council so the advisors engage it directly. Update this and call again to run the next round of the deliberation.",
        ),
      fresh: z
        .boolean()
        .optional()
        .describe(
          "Run each advisor on a throwaway session — independent of any prior conversation and discarded afterward — so the council's votes don't carry or leave cross-call context. Slower (each advisor spawns fresh). Default false (reuse the persistent collaborator sessions). Note: `fresh` makes each call independent, so it doesn't accumulate the host-mediated deliberation across calls.",
        ),
      members: z
        .array(z.enum(["claude", "codex", "grok"]))
        .optional()
        .describe(
          "Which members sit on the council for this call. Omit for the default — every active advisor (the members other than you). Name a subset to convene just those. (The host is never a member; it participates by driving the rounds.)",
        ),
      ...timeField,
    },
  },
  (args, extra) => runMagi(args, extra),
);

interface MagiArgs {
  question: string;
  context?: string;
  my_take?: string;
  fresh?: boolean;
  members?: MemberId[];
  time?: number;
}

/** Render one council voice (answer + any blocked actions + footer). */
function renderVoice(name: string, result: AskResult | null): string {
  const body = result && result.text.length > 0 ? result.text : `_(${name} returned no text)_`;
  const lines = [`### ${name}`, "", body];
  const blocked = (result?.log ?? [])
    .filter((l) => l.startsWith("auto-denied:"))
    .map((l) => l.replace(/^auto-denied:\s*/, ""));
  if (blocked.length > 0) lines.push("", `⚠️ blocked in council mode: ${blocked.join("; ")}`);
  if (result) lines.push("", footer(result));
  return lines.join("\n");
}

/** Resolves the session a council turn runs on — the persistent one, or an
 * ephemeral one for a `fresh` consult. */
type SessionFor = (id: MemberId) => AcpSession;
const persistentSession: SessionFor = (id) => sessions[id];

/**
 * Run one advisor's council turn (read-only, atomic — guardian "ask" auto-denies,
 * so it never suspends), returning both its rendered voice and its raw answer text
 * (for the settlement check). Member errors are caught and rendered, so one failing
 * advisor never sinks the others.
 */
async function councilTurn(
  id: MemberId,
  prompt: string,
  label: string,
  prefix: string,
  extra: Extra,
  notify: Notify,
  timeoutMs: number | undefined,
  getSession: SessionFor,
): Promise<{ name: string; markup: string; text: string }> {
  const name = specs[id].name;
  try {
    const outcome = await getSession(id).ask(prompt, {
      label,
      signal: extra.signal,
      timeoutMs,
      onAskPermission: "read-only",
      ...streamHooks(notify, prefix),
    });
    const result = outcome.type === "answer" ? outcome.result : null;
    return { name, markup: renderVoice(name, result), text: result?.text ?? "" };
  } catch (err) {
    return {
      name,
      markup: `### ${name}\n\n${renderMemberError(name, err, specs[id].loginHint).content[0]!.text}`,
      text: "",
    };
  }
}

/** Prepended when the host is unrecognized (one voice may be the host itself). */
function unknownHostWarning(): string | undefined {
  const r = resolveHost();
  return r.source === "unknown"
    ? `⚠️ Host not recognized (clientInfo: ${r.rawClient ?? "none"}); all three members are participating, so one of these voices may be you. Set \`MAGI_COUNCIL_EXCLUDE=claude|codex|grok\` to exclude yourself.`
    : undefined;
}

/**
 * Fan a task out to every active advisor and render their voices for the host to
 * synthesize. `buildPrompt(id)` produces each advisor's prompt. Advisors run
 * **concurrently** (each on its own session/gate) and are rendered in member
 * order; the whole council is still one atomic tool call. Each member is caught
 * independently so one failure still returns the others. (Advisors answer
 * independently; they do not see each other's replies.)
 */
async function councilFanOut(
  label: string,
  buildPrompt: (id: MemberId) => string,
  extra: Extra,
  timeoutMs: number | undefined,
  getSession: SessionFor = persistentSession,
  ids: MemberId[] = activeIds(),
  synth?: string,
): Promise<ToolResult> {
  const host = hostName();
  const sections: string[] = [];
  const warning = unknownHostWarning();
  if (warning) sections.push(warning);

  const notify = progressNotifier(extra); // one shared channel for all concurrent advisors
  const voices = await Promise.all(
    ids.map((id) =>
      councilTurn(id, buildPrompt(id), label, `${specs[id].name} `, extra, notify, timeoutMs, getSession),
    ),
  );
  sections.push(...voices.map((v) => v.markup));

  const footer =
    synth ??
    `_You (${host}) are the lead — weigh these voices and decide. Follow up with the active members' reply tools (\`codex_reply\` / \`grok_reply\` / \`claude_reply\`), or ask one directly (\`ask_codex\` / \`ask_grok\` / \`ask_claude\`)._`;
  return { content: [{ type: "text", text: [...sections, footer].join("\n\n---\n\n") }] };
}

/**
 * Run one round of the Magi council: every selected advisor answers the question
 * independently (concurrently), and the result tells the host to weigh in and call
 * again to deliberate. The host *is* the deliberation loop — there is no autonomous
 * multi-round mode; the host drives the rounds by re-calling with an updated
 * `my_take`. With `fresh`, each advisor runs on a throwaway session (so a call
 * doesn't carry or leave cross-call context — and so doesn't accumulate the loop).
 */
async function runMagi(args: MagiArgs, extra: Extra): Promise<ToolResult> {
  const { question, context, my_take, time } = args;
  const fresh = args.fresh ?? false;
  const timeoutMs = time !== undefined ? time * 1000 : undefined;
  const host = hostName();

  // Who's on the council this call: the default active advisors, or an explicit
  // subset of them. The host is never a member — it participates by *driving* the
  // rounds (see the closing instruction), not by being spawned.
  const active = selectCouncil(args.members, activeIds());
  if (active.length === 0) {
    return { content: [{ type: "text", text: "No active council members in your selection." }] };
  }

  // For `fresh`, give each advisor a one-shot session, disposed when this call
  // ends — never the persistent one.
  const ephemeral: Partial<Record<MemberId, AcpSession>> = {};
  const getSession: SessionFor = fresh
    ? (id) => (ephemeral[id] ??= new AcpSession(config, specs[id]))
    : persistentSession;

  try {
    return await councilFanOut(
      "consult",
      (id) =>
        magiAdvisorPrompt({
          advisor: specs[id].promptName,
          host,
          question,
          context,
          hostTake: my_take,
          fellowAdvisors: active.filter((x) => x !== id).map((x) => specs[x].name),
          grokStrengths: id === "grok",
        }),
      extra,
      timeoutMs,
      getSession,
      active,
      `_You (${host}) are the lead **and a participant** in this deliberation. Read these views and form your own position. **Unless you and the council have reached agreement, call \`consult\` again** with \`my_take\` set to your current position (and any new framing in \`context\`) to run the next round — the advisors keep their context and will respond to you. Iterate until you judge agreement is reached, then act on it. (Or ask one directly with \`ask_codex\`/\`ask_grok\`/\`ask_claude\`.)_`,
    );
  } finally {
    for (const s of Object.values(ephemeral)) s?.dispose();
  }
}

// --- Shared session controls ----------------------------------------------

server.registerTool(
  "permit",
  {
    description:
      "Resolve a permission a member raised mid-turn (when a tool just returned a 🔐 permission). Judge whether the action is reasonable, then allow or deny; the member's suspended turn resumes and runs to its next pause or its answer. Pass `member` if more than one is paused at once. Only valid right after a tool returned a permission request.",
    inputSchema: {
      decision: z.enum(["allow", "deny"]).describe("Whether to let the member perform the requested action."),
      member: z
        .enum(["claude", "codex", "grok"])
        .optional()
        .describe("Which member to resolve. Optional when only one is paused; required if more than one is."),
      note: z.string().optional().describe("Optional short reason for the decision (recorded in the debug log)."),
      ...timeField,
    },
  },
  ({ decision, member, note, time }, extra) => {
    const candidateIds = (member ? [member as MemberId] : activeIds()).filter(isActive);
    const pending = candidateIds.filter((id) => sessions[id].isAwaitingPermission());
    if (pending.length === 0) {
      const who = member ?? "any member";
      return {
        content: [
          {
            type: "text" as const,
            text: `No pending permission to resolve for ${who} — it may have already completed or been superseded by a newer request.`,
          },
        ],
      };
    }
    if (pending.length > 1) {
      return {
        content: [
          {
            type: "text" as const,
            text: `More than one member is paused awaiting a decision (${pending.join(", ")}) — call **permit** again with \`member\` set to one of them.`,
          },
        ],
      };
    }
    const target = sessions[pending[0]!];
    return target
      .permit(
        decision === "allow",
        {
          label: "permit",
          signal: extra.signal,
          timeoutMs: time !== undefined ? time * 1000 : undefined,
          ...streamHooks(progressNotifier(extra)),
        },
        note,
      )
      .then((outcome) => renderOutcome(outcome, target.name))
      .catch((err: unknown): ToolResult => {
        if (err instanceof NoPendingPermission) {
          return {
            content: [
              {
                type: "text",
                text: "No pending permission to resolve — it may have already completed or been superseded by a newer request.",
              },
            ],
          };
        }
        return renderMemberError(target.name, err, target.loginHint);
      });
  },
);

server.registerTool(
  "reset",
  {
    description:
      "Drop the accumulated session context for ALL members and start fresh. Use when switching to an unrelated task, when a member seems confused or its context has grown stale, or to clear a turn wedged awaiting a permit (this clears any pending permits). The next call to each member spins up a brand-new session. (When the host is Claude Code, this also happens automatically on /clear if the SessionStart hook is installed — see the README.)",
    inputSchema: {},
  },
  () => {
    for (const id of MEMBER_IDS) sessions[id].reset();
    return {
      content: [
        {
          type: "text" as const,
          text: "All member sessions reset — the next call to each starts a fresh session with no prior context.",
        },
      ],
    };
  },
);

server.registerTool(
  "status",
  {
    description:
      "Report magi-council's health: the resolved host (and how it was resolved), the active council, workspace, guardian flags, and each active member's session/subprocess liveness and pending permission. Read-only; does not start a session.",
    inputSchema: {},
  },
  () => {
    const r = resolveHost();
    const client = r.rawClient ? `clientInfo="${r.rawClient}"` : "clientInfo=none";
    const hostLine = r.excluded
      ? `host: ${specs[r.excluded].name} (excluded; source=${r.source}, ${client})`
      : `host: unknown — all three members active (source=unknown, ${client}); set MAGI_COUNCIL_EXCLUDE to exclude the host`;
    const lines = [
      `workspace: ${config.workspaceRoot}`,
      hostLine,
      `council: ${activeIds().map((i) => specs[i].name).join(", ")}`,
      "",
      ...activeIds().map((id) => renderStatus(sessions[id].status())),
    ];
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

function renderStatus(s: SessionStatus): string {
  const onoff = (b: boolean) => (b ? "on" : "off");
  return [
    `${s.name}:`,
    `  acp command: ${s.acpCommand}`,
    `  guardian: external-reads ${onoff(s.guardian.externalReads)} · writes ${onoff(s.guardian.writes)} · commands ${onoff(s.guardian.commands)}`,
    `  session: ${s.sessionStarted ? "started" : "not started"} · subprocess: ${s.childAlive ? "alive" : "down"}`,
    `  ${s.pendingPermission ? `awaiting permit: ${s.pendingPermission}` : "no pending permission"}`,
    s.stderrTail ? `  recent stderr:\n${s.stderrTail}` : "  no stderr captured",
  ].join("\n");
}

// Once the client identifies itself, resolve the host and remove its tools, so a
// compliant client never sees tools for the agent that's driving the council.
server.server.oninitialized = (): void => {
  const r = resolveHost();
  if (r.excluded) for (const t of memberTools[r.excluded]) t.remove();
  const hostLabel = r.excluded ? specs[r.excluded].name : "unknown (all active)";
  process.stderr.write(
    `[magi-council] host=${hostLabel} (source=${r.source}${r.rawClient ? `, client=${r.rawClient}` : ""}); council=${activeIds()
      .map((i) => specs[i].name)
      .join("+")}\n`,
  );
};

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGINT", () => {
  for (const id of MEMBER_IDS) sessions[id].dispose();
  process.exit(0);
});
process.on("SIGTERM", () => {
  for (const id of MEMBER_IDS) sessions[id].dispose();
  process.exit(0);
});
