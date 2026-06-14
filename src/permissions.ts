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

    case "execute":
      return config.allowCommands
        ? { allow: true, reason: "command execution (enabled)" }
        : { allow: false, reason: "command execution blocked" };

    default:
      // switch_mode, other, and anything new: refuse by default.
      return { allow: false, reason: `${kind} blocked by guardian` };
  }
}
