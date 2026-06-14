#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig } from "./config.ts";
import { CodexSession, type AskResult, type SessionStatus } from "./codex.ts";
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

/** Render a turn for Claude: Codex's answer, then a terse one-line footer. */
function render(result: AskResult): ToolResult {
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
  const blocked = result.log.filter((l) => l.startsWith("denied")).length;
  if (blocked > 0) parts.push(`⚠ ${blocked} blocked`);
  return { content: [{ type: "text", text: `${body}${stop}\n\n_${parts.join(" · ")}_` }] };
}

/** Last line / tail of the streamed text so far, for a rolling live view. */
const tail = (s: string): string => s.replace(/\s+/g, " ").trim().slice(-140);

/** Run a Codex turn, streaming progress to the client and honouring cancel. */
function ask(prompt: string, extra: Extra, label: string): Promise<ToolResult> {
  const token = extra._meta?.progressToken;
  let progress = 0;
  const notify = (message: string): void => {
    if (token === undefined) return;
    void extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress: ++progress, message },
    });
  };
  let acc = "";
  return codex
    .ask(prompt, {
      label,
      signal: extra.signal,
      onText: (chunk) => {
        acc += chunk;
        notify(tail(acc));
      },
      onActivity: (note) => notify(`↳ ${note}`),
    })
    .then(render);
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
      "Have Codex review code changes for correctness bugs and gaps. Pass a diff, or name paths and let Codex read the working tree. Codex debates back; continue with `reply`.",
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
  "status",
  {
    description:
      "Report codex-fusion's health: workspace, guardian flags, whether the Codex session/subprocess is alive, and recent codex-acp stderr. Read-only; does not start a session.",
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
