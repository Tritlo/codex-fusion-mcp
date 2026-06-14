import { isAbsolute, relative } from "node:path";
import type { ToolCallUpdate, ToolKind } from "@agentclientprotocol/sdk";
import type { Config } from "./config.ts";

/** A guardian verdict for one of Codex's permission requests. */
export interface Decision {
  allow: boolean;
  /** Human-readable justification, surfaced back to Claude in the tool result. */
  reason: string;
}

/** True if `target` is the workspace root or a path nested within it. */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Non-git programs that only read, safe to run under guardian mode. */
const READ_ONLY_PROGRAMS = new Set([
  "cat", "ls", "pwd", "head", "tail", "wc", "tree", "stat", "file",
  "rg", "grep", "diff", "nl", "basename", "dirname", "realpath", "echo", "true",
]);

/** git subcommands that only read repository state (never mutate). */
const READ_ONLY_GIT = new Set([
  "diff", "status", "log", "show", "blame", "ls-files", "ls-tree", "rev-parse",
  "cat-file", "describe", "shortlog", "rev-list", "diff-tree", "diff-index",
  "merge-base", "for-each-ref", "name-rev", "symbolic-ref", "whatchanged",
  "reflog", "grep", "show-ref", "var",
]);

/** Shell metacharacters that chain, substitute, or redirect — reject outright. */
const SHELL_METACHARS = /[;&|<>`$()\n\r]/;

/** The command string codex-acp wants to run, if this is a shell tool call. */
function commandString(toolCall: ToolCallUpdate): string | undefined {
  const raw = toolCall.rawInput;
  if (raw && typeof raw === "object" && "command" in raw) {
    const c = (raw as { command?: unknown }).command;
    if (typeof c === "string" && c.trim()) return c.trim();
    if (Array.isArray(c) && c.every((x) => typeof x === "string")) return c.join(" ").trim();
  }
  return undefined;
}

/** Program name with any leading path stripped: `/usr/bin/git` → `git`. */
const program = (token: string): string => token.split("/").pop() ?? token;

/** The git subcommand, skipping global options and their arguments. */
function gitSubcommand(tokens: string[]): string | undefined {
  for (let i = 1; i < tokens.length; ) {
    const t = tokens[i]!;
    if (t === "-C" || t === "-c") {
      i += 2; // option that consumes the following token as its argument
      continue;
    }
    if (t.startsWith("-")) {
      i += 1; // --foo, --foo=bar, -x
      continue;
    }
    return t;
  }
  return undefined;
}

/** True if `cmd` is a single read-only invocation safe under guardian mode. */
function isReadOnlyCommand(cmd: string): boolean {
  if (SHELL_METACHARS.test(cmd)) return false; // no chaining/substitution/redirection
  const tokens = cmd.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const prog = program(tokens[0]!);
  if (prog === "git") {
    const sub = gitSubcommand(tokens);
    return sub !== undefined && READ_ONLY_GIT.has(sub);
  }
  return READ_ONLY_PROGRAMS.has(prog);
}

/** True if any path-like argument escapes the workspace root. */
function commandEscapesWorkspace(root: string, cmd: string): boolean {
  for (const t of cmd.split(/\s+/)) {
    if (t.startsWith("-")) continue; // flag, not a path
    if (t.startsWith("~") || t.includes("..")) return true;
    if (t.startsWith("/") && !isInside(root, t)) return true;
  }
  return false;
}

/**
 * Decide whether to approve a Codex tool call under guardian mode.
 *
 * Guardian mode (all expansion flags off) approves only reads inside the
 * workspace and refuses everything else — writes, command execution, network
 * fetches, and any read that escapes the workspace root. Each {@link Config}
 * `allow*` flag widens exactly one of those categories. Pure function of the
 * request and config so the policy is trivial to reason about and test.
 */
export function guardianDecision(toolCall: ToolCallUpdate, config: Config): Decision {
  const kind: ToolKind = toolCall.kind ?? "other";
  const locations = (toolCall.locations ?? []).map((l) => l.path);
  const escaped = locations.filter((p) => !isInside(config.workspaceRoot, p));

  switch (kind) {
    case "read":
    case "search":
    case "think":
      if (escaped.length > 0 && !config.allowExternalReads) {
        return { allow: false, reason: `read outside workspace blocked (${escaped.join(", ")})` };
      }
      return { allow: true, reason: "read within scope" };

    case "fetch":
      // Network access is "outside the workspace" in spirit.
      return config.allowExternalReads
        ? { allow: true, reason: "network fetch (external reads enabled)" }
        : { allow: false, reason: "network fetch blocked" };

    case "edit":
    case "delete":
    case "move":
      if (!config.allowWrites) return { allow: false, reason: `write (${kind}) blocked` };
      if (escaped.length > 0) {
        return { allow: false, reason: `write outside workspace blocked (${escaped.join(", ")})` };
      }
      return { allow: true, reason: `write within workspace (${kind})` };

    case "execute": {
      if (config.allowCommands) return { allow: true, reason: "command execution (enabled)" };
      const cmd = commandString(toolCall);
      if (!cmd) return { allow: false, reason: "command execution blocked" };
      const shown = cmd.length > 60 ? `${cmd.slice(0, 60)}…` : cmd;
      if (!isReadOnlyCommand(cmd)) return { allow: false, reason: `non-read-only command blocked (${shown})` };
      if (!config.allowExternalReads && commandEscapesWorkspace(config.workspaceRoot, cmd)) {
        return { allow: false, reason: `command reads outside workspace blocked (${shown})` };
      }
      return { allow: true, reason: `read-only command (${shown})` };
    }

    default:
      // switch_mode, other, and anything new: refuse by default.
      return { allow: false, reason: `${kind} blocked by guardian` };
  }
}
