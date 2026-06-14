import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Path to the per-workspace reset nonce file.
 *
 * The {@link https://docs.claude.com/en/docs/claude-code/hooks SessionStart}
 * hook writes the new Claude session id here on `/clear`; the server polls it and
 * drops Codex's session when it changes. Keyed by a hash of the workspace path so
 * independent projects don't reset each other, and kept in the OS temp dir so it
 * never pollutes the repo. Both the hook and the server import this one function,
 * so the path can't drift between them.
 */
export function resetNonceFile(workspaceRoot: string): string {
  const hash = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  return join(tmpdir(), `codex-fusion-reset-${hash}`);
}
