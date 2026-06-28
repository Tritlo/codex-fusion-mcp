#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig, MEMBER_IDS, type MemberId, type MemberSpec } from "./config.ts";
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
  askGrokPrompt,
  brainstormPrompt,
  consultPrompt,
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

/** Streaming hooks that forward a member's output to the client as progress. */
function streamHooks(extra: Extra, prefix = ""): Pick<AskOptions, "onText" | "onThought" | "onActivity"> {
  const token = extra._meta?.progressToken;
  let progress = 0;
  let acc = "";
  let thinking = "";
  const notify = (message: string): void => {
    if (token === undefined) return;
    void extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress: ++progress, message },
    });
  };
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
    .ask(prompt, { label, signal: extra.signal, timeoutMs, ...streamHooks(extra) })
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

// --- Codex tools (the default primary advisor) ----------------------------

memberTools.codex.push(
  server.registerTool(
    "consult",
    {
      description:
        "Ask Codex (GPT-5) for an independent second opinion on a specific question or decision. Use to pressure-test a choice you're about to make. Codex debates back; continue with `reply` (cap ~3 turns).",
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
        ? ask("codex", consultPrompt(hostName(), question, context), extra, "consult", time)
        : inactiveResult("codex"),
  ),
);

memberTools.codex.push(
  server.registerTool(
    "review_plan",
    {
      description:
        "Have Codex critique a plan or approach BEFORE you implement it — verdict, problems by severity, blind spots, and what to keep. Codex debates back; continue with `reply`.",
      inputSchema: {
        plan: z.string().describe("The plan/approach to review (steps, design, or intended changes)."),
        context: z.string().optional().describe("Optional background or constraints."),
        ...timeField,
      },
    },
    ({ plan, context, time }, extra) =>
      isActive("codex")
        ? ask("codex", reviewPlanPrompt(hostName(), plan, context), extra, "review_plan", time)
        : inactiveResult("codex"),
  ),
);

memberTools.codex.push(
  server.registerTool(
    "review_diff",
    {
      description:
        "Have Codex review code changes for correctness bugs and gaps. Pass a diff, or name paths and let Codex read the working tree (it may ask permission to run `git diff`). Codex debates back; continue with `reply`.",
      inputSchema: {
        diff: z.string().optional().describe("A unified diff to review. Omit to let Codex inspect `git diff` itself."),
        paths: z.string().optional().describe("Paths to focus on (used when no diff is supplied)."),
        instructions: z.string().optional().describe("Optional extra focus for the review."),
        ...timeField,
      },
    },
    ({ diff, paths, instructions, time }, extra) =>
      isActive("codex")
        ? ask("codex", reviewDiffPrompt(hostName(), { diff, paths, instructions }), extra, "review_diff", time)
        : inactiveResult("codex"),
  ),
);

memberTools.codex.push(
  server.registerTool(
    "brainstorm",
    {
      description:
        "Co-design with Codex: get 2–4 alternative approaches with trade-offs and a recommendation, to compare against your own. Codex debates back; continue with `reply`.",
      inputSchema: {
        problem: z.string().describe("The design problem to explore."),
        constraints: z.string().optional().describe("Optional constraints, requirements, or non-goals."),
        ...timeField,
      },
    },
    ({ problem, constraints, time }, extra) =>
      isActive("codex")
        ? ask("codex", brainstormPrompt(hostName(), problem, constraints), extra, "brainstorm", time)
        : inactiveResult("codex"),
  ),
);

memberTools.codex.push(
  server.registerTool(
    "explore",
    {
      description:
        "Have Codex explore an unfamiliar codebase and report its structure, key components, data/control flow, and conventions. Good for initial orientation.",
      inputSchema: {
        focus: z
          .string()
          .optional()
          .describe("What to focus the exploration on (a feature, subsystem, or question)."),
        paths: z.string().optional().describe("Optional starting paths."),
        ...timeField,
      },
    },
    ({ focus, paths, time }, extra) =>
      isActive("codex")
        ? ask("codex", explorePrompt(hostName(), focus, paths), extra, "explore", time)
        : inactiveResult("codex"),
  ),
);

memberTools.codex.push(
  server.registerTool(
    "reply",
    {
      description:
        "Continue the current debate with Codex: send a rebuttal or follow-up on the SAME session (it remembers the thread). Use to push back on Codex's last answer and drive toward consensus — keep the whole debate to ~3 turns.",
      inputSchema: {
        message: z.string().describe("Your rebuttal, counter-point, or follow-up question for Codex."),
        ...timeField,
      },
    },
    ({ message, time }, extra) =>
      isActive("codex")
        ? ask("codex", replyPrompt(hostName(), message), extra, "reply", time)
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

// --- The Magi council -----------------------------------------------------

server.registerTool(
  "ask_magi",
  {
    description:
      "Convene the Magi council — your advisors (the council members other than you) each give an independent view on a question, and you synthesize. Every active advisor weighs in. Also: \"the council\". Follow up with the active members' reply tools (`reply`/`grok_reply`/`ask_claude`).",
    inputSchema: {
      question: z.string().describe("The question or decision to put to the council."),
      context: z.string().optional().describe("Optional background or constraints."),
      my_take: z
        .string()
        .optional()
        .describe("Your own current position, put before the council so the advisors can engage it directly."),
      ...timeField,
    },
  },
  (args, extra) => runMagi(args, extra),
);

interface MagiArgs {
  question: string;
  context?: string;
  my_take?: string;
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

/**
 * Run one Magi round: every active advisor answers the same question
 * independently, in member order. Sequential and atomic — each turn auto-denies
 * guardian "ask" so the whole council is one tool call. Each member is caught
 * independently so one failure still returns the others.
 */
async function runMagi(args: MagiArgs, extra: Extra): Promise<ToolResult> {
  const { question, context, my_take, time } = args;
  const timeoutMs = time !== undefined ? time * 1000 : undefined;
  const host = hostName();
  const r = resolveHost();
  const active = activeIds();
  const sections: string[] = [];

  if (r.source === "unknown") {
    sections.push(
      `⚠️ Host not recognized (clientInfo: ${r.rawClient ?? "none"}); all three members are participating, so one of these voices may be you. Set \`MAGI_COUNCIL_EXCLUDE=claude|codex|grok\` to exclude yourself.`,
    );
  }

  for (const id of active) {
    const fellowAdvisors = active.filter((x) => x !== id).map((x) => specs[x].name);
    try {
      const outcome = await sessions[id].ask(
        magiAdvisorPrompt({
          advisor: specs[id].promptName,
          host,
          question,
          context,
          hostTake: my_take,
          fellowAdvisors,
          grokStrengths: id === "grok",
        }),
        { label: "magi", signal: extra.signal, timeoutMs, onAskPermission: "deny", ...streamHooks(extra, `${specs[id].name} `) },
      );
      const result = outcome.type === "answer" ? outcome.result : null;
      sections.push(renderVoice(specs[id].name, result));
    } catch (err) {
      sections.push(`### ${specs[id].name}\n\n${renderMemberError(specs[id].name, err, specs[id].loginHint).content[0]!.text}`);
    }
  }

  const synth = `_You (${host}) are the lead — weigh these voices and decide. Follow up with the active members' reply tools (\`reply\` / \`grok_reply\` / \`claude_reply\`)._`;
  return { content: [{ type: "text", text: [...sections, synth].join("\n\n---\n\n") }] };
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
          ...streamHooks(extra),
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
