import { isAbsolute, relative } from "node:path";
import type { ToolCallUpdate, ToolKind } from "@agentclientprotocol/sdk";
import type { Config } from "./config.ts";

/** What guardian does with one of Codex's permission requests. */
export type Guard =
  | { decision: "allow"; reason: string } // auto-approved by policy, no round-trip
  | { decision: "ask"; reason: string }; // hand back to Claude to judge

/** True if `target` is the workspace root or a path nested within it. */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Guardian policy: a pure function of the request and config.
 *
 * Auto-approve only the cheap, clearly-safe cases — reading and searching
 * *inside* the workspace — so Codex can explore without a round-trip per file.
 * Everything else (commands, writes, network, out-of-workspace reads) is handed
 * back to Claude, which inspects the request and decides allow/deny. The
 * `allow*` flags downgrade a whole category from "ask" to "auto-allow" for users
 * who would rather not be prompted. Trying to encode command safety as a static
 * allowlist proved a losing game; Claude's judgement is the policy instead.
 */
export function guardianDecision(toolCall: ToolCallUpdate, config: Config): Guard {
  const kind: ToolKind = toolCall.kind ?? "other";
  const locations = (toolCall.locations ?? []).map((l) => l.path);
  const escaped = locations.filter((p) => !isInside(config.workspaceRoot, p));

  switch (kind) {
    case "read":
    case "search":
    case "think":
      if (escaped.length > 0 && !config.allowExternalReads) {
        return { decision: "ask", reason: `read outside workspace (${escaped.join(", ")})` };
      }
      return { decision: "allow", reason: "read within workspace" };

    case "fetch":
      return config.allowExternalReads
        ? { decision: "allow", reason: "network fetch (external reads enabled)" }
        : { decision: "ask", reason: "network fetch" };

    case "edit":
    case "delete":
    case "move":
      if (config.allowWrites && escaped.length === 0) {
        return { decision: "allow", reason: `write within workspace (${kind})` };
      }
      return {
        decision: "ask",
        reason: escaped.length > 0 ? `write outside workspace (${kind}: ${escaped.join(", ")})` : `write (${kind})`,
      };

    case "execute":
      return config.allowCommands
        ? { decision: "allow", reason: "command execution (enabled)" }
        : { decision: "ask", reason: "run a command" };

    default:
      return { decision: "ask", reason: String(kind) };
  }
}

/** A short, human-readable description of what Codex wants, for Claude to judge. */
export function describePermission(toolCall: ToolCallUpdate): string {
  const kind = toolCall.kind ?? "action";
  const raw = toolCall.rawInput;
  const command =
    raw && typeof raw === "object" && "command" in raw ? (raw as { command?: unknown }).command : undefined;
  const commandStr =
    typeof command === "string"
      ? command
      : Array.isArray(command) && command.every((x) => typeof x === "string")
        ? command.join(" ")
        : undefined;
  const locations = (toolCall.locations ?? []).map((l) => l.path);
  const detail =
    commandStr ??
    (typeof toolCall.title === "string" ? toolCall.title : undefined) ??
    (locations.length > 0 ? locations.join(", ") : undefined);
  return detail ? `${kind}: ${detail}` : String(kind);
}
