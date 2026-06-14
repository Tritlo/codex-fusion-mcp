#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.ts";
import { CodexSession, type AskResult } from "./codex.ts";
import {
  brainstormPrompt,
  consultPrompt,
  explorePrompt,
  reviewDiffPrompt,
  reviewPlanPrompt,
} from "./prompts.ts";

const config = loadConfig();
const codex = new CodexSession(config);

/** Render a turn result for Claude: guardian log first, then Codex's answer. */
function render(result: AskResult): { content: Array<{ type: "text"; text: string }> } {
  const guardian = result.log.length > 0 ? `> guardian: ${result.log.join(" · ")}\n\n` : "";
  const stopped = result.stopReason !== "end_turn" ? `\n\n_(codex stopped: ${result.stopReason})_` : "";
  const body = result.text.length > 0 ? result.text : "_(codex returned no text)_";
  return { content: [{ type: "text", text: `${guardian}${body}${stopped}` }] };
}

const ask = (prompt: string) => codex.ask(prompt).then(render);

const server = new McpServer({ name: "codex-fusion", version: "0.1.0" });

server.registerTool(
  "consult",
  {
    description:
      "Ask Codex (GPT-5) for an independent second opinion on a specific question or decision. Use to pressure-test a choice you're about to make.",
    inputSchema: {
      question: z.string().describe("The specific question or decision to put to Codex."),
      context: z
        .string()
        .optional()
        .describe("Optional background: your current thinking, constraints, or relevant snippets."),
    },
  },
  ({ question, context }) => ask(consultPrompt(question, context)),
);

server.registerTool(
  "review_plan",
  {
    description:
      "Have Codex critique a plan or approach BEFORE you implement it — verdict, problems by severity, blind spots, and what to keep.",
    inputSchema: {
      plan: z.string().describe("The plan/approach to review (steps, design, or intended changes)."),
      context: z.string().optional().describe("Optional background or constraints."),
    },
  },
  ({ plan, context }) => ask(reviewPlanPrompt(plan, context)),
);

server.registerTool(
  "review_diff",
  {
    description:
      "Have Codex review code changes for correctness bugs and gaps. Pass a diff, or name paths and let Codex read the working tree.",
    inputSchema: {
      diff: z.string().optional().describe("A unified diff to review. Omit to let Codex inspect `git diff` itself."),
      paths: z.string().optional().describe("Paths to focus on (used when no diff is supplied)."),
      instructions: z.string().optional().describe("Optional extra focus for the review."),
    },
  },
  ({ diff, paths, instructions }) => ask(reviewDiffPrompt({ diff, paths, instructions })),
);

server.registerTool(
  "brainstorm",
  {
    description:
      "Co-design with Codex: get 2–4 alternative approaches with trade-offs and a recommendation, to compare against your own.",
    inputSchema: {
      problem: z.string().describe("The design problem to explore."),
      constraints: z.string().optional().describe("Optional constraints, requirements, or non-goals."),
    },
  },
  ({ problem, constraints }) => ask(brainstormPrompt(problem, constraints)),
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
  ({ focus, paths }) => ask(explorePrompt(focus, paths)),
);

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
