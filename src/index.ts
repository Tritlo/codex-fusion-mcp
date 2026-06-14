#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig } from "./config.ts";
import {
  CodexSession,
  NoPendingPermission,
  type AskOptions,
  type AskResult,
  type SessionStatus,
  type TurnOutcome,
} from "./codex.ts";
import {
  brainstormPrompt,
  consultPrompt,
  explorePrompt,
  replyPrompt,
  reviewDiffPrompt,
  reviewPlanPrompt,
} from "./prompts.ts";

const config = loadConfig();
const codex = new CodexSession(config);

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ToolResult = { content: Array<{ type: "text"; text: string }> };

const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

/** Render a finished turn for Claude: Codex's answer, then a terse one-line footer. */
function renderAnswer(result: AskResult): ToolResult {
  const body = result.text.length > 0 ? result.text : "_(codex returned no text)_";
  const stop =
    result.stopReason === "end_turn"
      ? ""
      : result.stopReason === "timeout"
        ? "\n\n_(codex timed out — raise CODEX_FUSION_TURN_TIMEOUT_MS or narrow the question)_"
        : result.stopReason === "cancelled"
          ? "\n\n_(cancelled)_"
          : `\n\n_(codex stopped: ${result.stopReason})_`;
  const parts = [`${(result.ms / 1000).toFixed(1)}s`];
  if (result.usage) parts.push(`${fmtTokens(result.usage.totalTokens)} tok`);
  return { content: [{ type: "text", text: `${body}${stop}\n\n_${parts.join(" · ")}_` }] };
}

/** Render whatever a turn produced: an answer, or a permission for Claude to judge. */
function renderOutcome(outcome: TurnOutcome): ToolResult {
  if (outcome.type === "permission") {
    return {
      content: [
        {
          type: "text",
          text:
            `🔐 Codex paused and needs your permission to continue:\n\n` +
            `    ${outcome.description}\n\n` +
            `Decide whether this is reasonable, then call **permit** with decision \`allow\` or ` +
            `\`deny\` to resume the turn — Codex is waiting on the same session.`,
        },
      ],
    };
  }
  return renderAnswer(outcome.result);
}

/** Last line / tail of the streamed text so far, for a rolling live view. */
const tail = (s: string): string => s.replace(/\s+/g, " ").trim().slice(-140);

/** Streaming hooks that forward Codex's output to the client as progress. */
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

/** Start a Codex turn, streaming progress and honouring cancellation. */
function ask(prompt: string, extra: Extra, label: string): Promise<ToolResult> {
  return codex.ask(prompt, { label, signal: extra.signal, ...streamHooks(extra) }).then(renderOutcome);
}

const server = new McpServer({ name: "codex-fusion", version: "0.1.0" });

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
    },
  },
  ({ question, context }, extra) => ask(consultPrompt(question, context), extra, "consult"),
);

server.registerTool(
  "review_plan",
  {
    description:
      "Have Codex critique a plan or approach BEFORE you implement it — verdict, problems by severity, blind spots, and what to keep. Codex debates back; continue with `reply`.",
    inputSchema: {
      plan: z.string().describe("The plan/approach to review (steps, design, or intended changes)."),
      context: z.string().optional().describe("Optional background or constraints."),
    },
  },
  ({ plan, context }, extra) => ask(reviewPlanPrompt(plan, context), extra, "review_plan"),
);

server.registerTool(
  "review_diff",
  {
    description:
      "Have Codex review code changes for correctness bugs and gaps. Pass a diff, or name paths and let Codex read the working tree (it may ask permission to run `git diff`). Codex debates back; continue with `reply`.",
    inputSchema: {
      diff: z.string().optional().describe("A unified diff to review. Omit to let Codex inspect `git diff` itself."),
      paths: z.string().optional().describe("Paths to focus on (used when no diff is supplied)."),
      instructions: z.string().optional().describe("Optional extra focus for the review."),
    },
  },
  ({ diff, paths, instructions }, extra) => ask(reviewDiffPrompt({ diff, paths, instructions }), extra, "review_diff"),
);

server.registerTool(
  "brainstorm",
  {
    description:
      "Co-design with Codex: get 2–4 alternative approaches with trade-offs and a recommendation, to compare against your own. Codex debates back; continue with `reply`.",
    inputSchema: {
      problem: z.string().describe("The design problem to explore."),
      constraints: z.string().optional().describe("Optional constraints, requirements, or non-goals."),
    },
  },
  ({ problem, constraints }, extra) => ask(brainstormPrompt(problem, constraints), extra, "brainstorm"),
);

server.registerTool(
  "explore",
  {
    description:
      "Have Codex explore an unfamiliar codebase and report its structure, key components, data/control flow, and conventions. Good for initial orientation.",
    inputSchema: {
      focus: z.string().optional().describe("What to focus the exploration on (a feature, subsystem, or question)."),
      paths: z.string().optional().describe("Optional starting paths."),
    },
  },
  ({ focus, paths }, extra) => ask(explorePrompt(focus, paths), extra, "explore"),
);

server.registerTool(
  "reply",
  {
    description:
      "Continue the current debate: send a rebuttal or follow-up to Codex on the SAME session (it remembers the thread). Use to push back on Codex's last answer and drive toward consensus — keep the whole debate to ~3 turns.",
    inputSchema: {
      message: z.string().describe("Your rebuttal, counter-point, or follow-up question for Codex."),
    },
  },
  ({ message }, extra) => ask(replyPrompt(message), extra, "reply"),
);

server.registerTool(
  "permit",
  {
    description:
      "Resolve a permission request Codex raised mid-turn (when a consult/review/etc. just returned a 🔐 permission). Judge whether the action is reasonable, then allow or deny; Codex's suspended turn resumes and runs to its next pause or its answer. Only valid right after a tool returned a permission request.",
    inputSchema: {
      decision: z.enum(["allow", "deny"]).describe("Whether to let Codex perform the requested action."),
      note: z.string().optional().describe("Optional short reason for the decision (recorded in the debug log)."),
    },
  },
  ({ decision, note }, extra) =>
    codex
      .permit(decision === "allow", { label: "permit", signal: extra.signal, ...streamHooks(extra) }, note)
      .then(renderOutcome)
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
      }),
);

server.registerTool(
  "reset",
  {
    description:
      "Drop Codex's accumulated session context and start fresh. Use when switching to an unrelated task, when Codex seems confused or its context has grown stale over a long session, or to clear a turn wedged awaiting a permit. The next consult/review/etc. spins up a brand-new Codex session with no prior memory of the conversation. (On /clear this happens automatically if the SessionStart hook is installed — see the README.)",
    inputSchema: {},
  },
  () => {
    codex.reset();
    return {
      content: [
        {
          type: "text" as const,
          text: "Codex session reset — the next call starts a fresh session with no prior context.",
        },
      ],
    };
  },
);

server.registerTool(
  "status",
  {
    description:
      "Report codex-fusion's health: workspace, guardian flags, whether the Codex session/subprocess is alive, and any pending permission. Read-only; does not start a session.",
    inputSchema: {},
  },
  () => ({ content: [{ type: "text" as const, text: renderStatus(codex.status()) }] }),
);

function renderStatus(s: SessionStatus): string {
  const onoff = (b: boolean) => (b ? "on" : "off");
  return [
    `workspace: ${s.workspaceRoot}`,
    `acp command: ${s.acpCommand}`,
    `guardian: external-reads ${onoff(s.guardian.externalReads)} · writes ${onoff(s.guardian.writes)} · commands ${onoff(s.guardian.commands)}`,
    `session: ${s.sessionStarted ? "started" : "not started"} · subprocess: ${s.childAlive ? "alive" : "down"}`,
    s.pendingPermission ? `awaiting permit: ${s.pendingPermission}` : "no pending permission",
    s.stderrTail ? `\nrecent codex-acp stderr:\n${s.stderrTail}` : "no codex-acp stderr captured",
  ].join("\n");
}

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGINT", () => {
  codex.dispose();
  process.exit(0);
});
process.on("SIGTERM", () => {
  codex.dispose();
  process.exit(0);
});
