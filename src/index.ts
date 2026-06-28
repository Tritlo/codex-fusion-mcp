#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig, type CouncilMemberConfig } from "./config.ts";
import {
  AcpAgentSession,
  NoPendingPermission,
  type AskOptions,
  type AskResult,
  type SessionStatus,
  type TurnOutcome,
} from "./acp.ts";
import {
  brainstormPrompt,
  consultPrompt,
  explorePrompt,
  replyPrompt,
  reviewDiffPrompt,
  reviewPlanPrompt,
} from "./prompts.ts";

const config = loadConfig();
const sessions = new Map(config.members.map((member) => [member.name, new AcpAgentSession(config, member)]));

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ToolResult = { content: Array<{ type: "text"; text: string }> };
type Target = { member: CouncilMemberConfig; session: AcpAgentSession };

const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
const memberNames = (): string => config.members.map((m) => m.name).join(", ");

const memberField = {
  member: z
    .string()
    .optional()
    .describe(
      `Council member to ask. Available: ${memberNames()}. Omit for the Codex head (${config.headMember}); use delegates like gemini/grok only when their extra quota cost is worth it.`,
    ),
};

const permitMemberField = {
  member: z
    .string()
    .optional()
    .describe(
      `Council member with the pending permission. Available: ${memberNames()}. Omit only when exactly one member is waiting.`,
    ),
};

function memberTarget(name: string): Target {
  const member = config.members.find((m) => m.name === name);
  const session = sessions.get(name);
  if (!member || !session) {
    throw new Error(`Unknown council member "${name}". Available members: ${memberNames()}.`);
  }
  return { member, session };
}

function selectMember(memberName?: string): Target {
  return memberTarget(memberName?.trim().toLowerCase() || config.headMember);
}

function selectPendingOrHead(memberName?: string): Target {
  if (memberName !== undefined && memberName.trim().length > 0) return selectMember(memberName);
  const pending = config.members.filter((m) => sessions.get(m.name)?.status().pendingPermission);
  return pending.length === 1 ? memberTarget(pending[0]!.name) : memberTarget(config.headMember);
}

/** Render a finished turn for Claude: the member's answer, then a terse one-line footer. */
function renderAnswer(result: AskResult, member: CouncilMemberConfig): ToolResult {
  const body = result.text.length > 0 ? result.text : `_(${member.name} returned no text)_`;
  const stop =
    result.stopReason === "end_turn"
      ? ""
      : result.stopReason === "timeout"
        ? `\n\n_(${member.name} went silent — pass a larger \`time\` (seconds) to extend the idle timeout, or narrow the question)_`
        : result.stopReason === "cancelled"
          ? "\n\n_(cancelled)_"
          : `\n\n_(${member.name} stopped: ${result.stopReason})_`;
  const parts = [member.name, `${(result.ms / 1000).toFixed(1)}s`];
  if (result.usage) parts.push(`${fmtTokens(result.usage.totalTokens)} tok`);
  return { content: [{ type: "text", text: `${body}${stop}\n\n_${parts.join(" · ")}_` }] };
}

/** Render whatever a turn produced: an answer, or a permission for Claude to judge. */
function renderOutcome(outcome: TurnOutcome, member: CouncilMemberConfig): ToolResult {
  if (outcome.type === "permission") {
    return {
      content: [
        {
          type: "text",
          text:
            `🔐 ${member.displayName} paused and needs your permission to continue:\n\n` +
            `    ${outcome.description}\n\n` +
            `Decide whether this is reasonable, then call **permit** with decision \`allow\` or ` +
            `\`deny\`${member.name === config.headMember ? "" : ` and member \`${member.name}\``} to resume the turn — ${member.name} is waiting on the same session.`,
        },
      ],
    };
  }
  return renderAnswer(outcome.result, member);
}

/** Last line / tail of the streamed text so far, for a rolling live view. */
const tail = (s: string): string => s.replace(/\s+/g, " ").trim().slice(-140);

/** Streaming hooks that forward member output to the client as progress. */
function streamHooks(extra: Extra): Pick<AskOptions, "onText" | "onThought" | "onActivity"> {
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
      notify(tail(acc));
    },
    onThought: (chunk) => {
      thinking += chunk;
      notify(`💭 ${tail(thinking)}`);
    },
    onActivity: (note) => notify(`↳ ${note}`),
  };
}

/** Start a member turn, streaming progress and honouring cancellation. */
function ask(target: Target, prompt: string, extra: Extra, label: string, time?: number): Promise<ToolResult> {
  const timeoutMs = time !== undefined ? time * 1000 : undefined;
  return target.session
    .ask(prompt, { label, signal: extra.signal, timeoutMs, ...streamHooks(extra) })
    .then((outcome) => renderOutcome(outcome, target.member));
}

/**
 * Optional per-call override of the idle timeout, in seconds. The clock is
 * measured from the member's last output, so an actively-working turn is never cut
 * off; raise this only for big reviews/explorations that may pause for long
 * stretches (e.g. a slow tool call) before producing more output.
 */
const timeField = {
  time: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional idle timeout in seconds for this call, overriding the default. The clock runs from the member's last output, so a turn that keeps streaming is never cut off — raise this for large reviews/explorations that may go quiet for a while.",
    ),
};

const server = new McpServer({ name: "codex-fusion", version: "0.1.0" });

server.registerTool(
  "consult",
  {
    description:
      "Ask the Codex head, or an explicit rare delegate, for an independent second opinion on a specific question or decision. Use Gemini/Grok only for high-value escalation because they may burn limited subscription quota. Continue with `reply` (cap ~3 turns).",
    inputSchema: {
      ...memberField,
      question: z.string().describe("The specific question or decision to put to the selected member."),
      context: z
        .string()
        .optional()
        .describe("Optional background: your current thinking, constraints, or relevant snippets."),
      ...timeField,
    },
  },
  ({ member, question, context, time }, extra) => {
    const target = selectMember(member);
    return ask(target, consultPrompt(target.member.displayName, question, context), extra, "consult", time);
  },
);

server.registerTool(
  "review_plan",
  {
    description:
      "Have the Codex head, or an explicit rare delegate, critique a plan BEFORE implementation — verdict, problems by severity, blind spots, and what to keep. Use Gemini/Grok only when the extra quota cost is justified.",
    inputSchema: {
      ...memberField,
      plan: z.string().describe("The plan/approach to review (steps, design, or intended changes)."),
      context: z.string().optional().describe("Optional background or constraints."),
      ...timeField,
    },
  },
  ({ member, plan, context, time }, extra) => {
    const target = selectMember(member);
    return ask(target, reviewPlanPrompt(target.member.displayName, plan, context), extra, "review_plan", time);
  },
);

server.registerTool(
  "review_diff",
  {
    description:
      "Have the Codex head, or an explicit rare delegate, review code changes for correctness bugs and gaps. Pass a diff, or name paths and let the member read the working tree. Use Gemini/Grok only for high-value second opinions.",
    inputSchema: {
      ...memberField,
      diff: z.string().optional().describe("A unified diff to review. Omit to let the selected member inspect `git diff` itself."),
      paths: z.string().optional().describe("Paths to focus on (used when no diff is supplied)."),
      instructions: z.string().optional().describe("Optional extra focus for the review."),
      ...timeField,
    },
  },
  ({ member, diff, paths, instructions, time }, extra) => {
    const target = selectMember(member);
    return ask(
      target,
      reviewDiffPrompt(target.member.displayName, { diff, paths, instructions }),
      extra,
      "review_diff",
      time,
    );
  },
);

server.registerTool(
  "brainstorm",
  {
    description:
      "Co-design with the Codex head, or an explicit rare delegate: get 2–4 alternatives with trade-offs and a recommendation. Use Gemini/Grok sparingly for hard calls where model diversity matters.",
    inputSchema: {
      ...memberField,
      problem: z.string().describe("The design problem to explore."),
      constraints: z.string().optional().describe("Optional constraints, requirements, or non-goals."),
      ...timeField,
    },
  },
  ({ member, problem, constraints, time }, extra) => {
    const target = selectMember(member);
    return ask(target, brainstormPrompt(target.member.displayName, problem, constraints), extra, "brainstorm", time);
  },
);

server.registerTool(
  "explore",
  {
    description:
      "Have the Codex head, or an explicit rare delegate, explore an unfamiliar codebase and report structure, key components, flow, and conventions. Prefer Codex for routine exploration.",
    inputSchema: {
      ...memberField,
      focus: z.string().optional().describe("What to focus the exploration on (a feature, subsystem, or question)."),
      paths: z.string().optional().describe("Optional starting paths."),
      ...timeField,
    },
  },
  ({ member, focus, paths, time }, extra) => {
    const target = selectMember(member);
    return ask(target, explorePrompt(target.member.displayName, focus, paths), extra, "explore", time);
  },
);

server.registerTool(
  "reply",
  {
    description:
      "Continue a debate with the Codex head unless `member` explicitly names a delegate. To continue a Gemini/Grok exchange, pass that same member again; delegate replies are not sticky because they may burn limited quota.",
    inputSchema: {
      ...memberField,
      message: z.string().describe("Your rebuttal, counter-point, or follow-up question for the selected member."),
      ...timeField,
    },
  },
  ({ member, message, time }, extra) => {
    const target = selectMember(member);
    return ask(target, replyPrompt(message), extra, "reply", time);
  },
);

server.registerTool(
  "permit",
  {
    description:
      "Resolve a permission request a council member raised mid-turn. Omit `member` only when there is exactly one pending permission; otherwise pass the waiting member explicitly. The suspended turn resumes to its next pause or answer.",
    inputSchema: {
      ...permitMemberField,
      decision: z.enum(["allow", "deny"]).describe("Whether to let the selected member perform the requested action."),
      note: z.string().optional().describe("Optional short reason for the decision (recorded in the debug log)."),
      ...timeField,
    },
  },
  ({ member, decision, note, time }, extra) => {
    const target = selectPendingOrHead(member);
    return target.session
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
      .then((outcome) => renderOutcome(outcome, target.member))
      .catch((err: unknown): ToolResult => {
        // Only swallow the "nothing to resolve" case; a failure inside the
        // resumed turn must surface, not be masked as a missing permission.
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
        throw err;
      });
  },
);

server.registerTool(
  "reset",
  {
    description:
      "Drop council member session context and start fresh. Use when switching to an unrelated task, when a member seems confused or its context has grown stale over a long session, or to clear a turn wedged awaiting a permit. Omit `member` to reset every configured member. (On /clear this happens automatically if the SessionStart hook is installed — see the README.)",
    inputSchema: {
      member: z
        .string()
        .optional()
        .describe(`Member to reset, or "all". Available: ${memberNames()}. Omit to reset all members.`),
    },
  },
  ({ member }) => {
    const name = member?.trim().toLowerCase();
    const targets =
      name === undefined || name.length === 0 || name === "all"
        ? config.members.map((m) => ({ member: m, session: sessions.get(m.name)! }))
        : [selectMember(name)];
    for (const target of targets) target.session.reset();
    return {
      content: [
        {
          type: "text" as const,
          text:
            targets.length === 1
              ? `${targets[0]!.member.displayName} session reset — the next call starts fresh.`
              : `Council sessions reset (${targets.map((t) => t.member.name).join(", ")}) — the next calls start fresh.`,
        },
      ],
    };
  },
);

server.registerTool(
  "status",
  {
    description:
      "Report codex-fusion's health: workspace, configured members, guardian flags, session/subprocess liveness, and pending permissions. Read-only; does not start a session.",
    inputSchema: {},
  },
  () => ({
    content: [
      {
        type: "text" as const,
        text: config.members.map((member) => renderStatus(sessions.get(member.name)!.status())).join("\n\n"),
      },
    ],
  }),
);

function renderStatus(s: SessionStatus): string {
  const onoff = (b: boolean) => (b ? "on" : "off");
  return [
    `[${s.memberName}] ${s.displayName}${s.memberName === config.headMember ? " (head)" : ""}`,
    `workspace: ${s.workspaceRoot}`,
    `acp command: ${s.acpCommand}`,
    `guardian: external-reads ${onoff(s.guardian.externalReads)} · writes ${onoff(s.guardian.writes)} · commands ${onoff(s.guardian.commands)}`,
    `session: ${s.sessionStarted ? "started" : "not started"} · subprocess: ${s.childAlive ? "alive" : "down"}`,
    s.pendingPermission ? `awaiting permit: ${s.pendingPermission}` : "no pending permission",
    s.stderrTail ? `\nrecent ${s.memberName} ACP stderr:\n${s.stderrTail}` : `no ${s.memberName} ACP stderr captured`,
  ].join("\n");
}

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGINT", () => {
  for (const session of sessions.values()) session.dispose();
  process.exit(0);
});
process.on("SIGTERM", () => {
  for (const session of sessions.values()) session.dispose();
  process.exit(0);
});
