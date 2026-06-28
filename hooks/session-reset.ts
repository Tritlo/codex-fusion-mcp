#!/usr/bin/env bun
// Claude Code SessionStart hook for magi-council.
//
// On `/clear` (source === "clear"), write the new Claude session id to the
// per-workspace nonce file the magi-council MCP server polls, so the server
// drops the members' stale context before the next consult. A no-op for startup,
// resume, and compact — those either coincide with a fresh server or are meant
// to preserve continuity. Reuses src/reset.ts so the path matches the server's.
import { renameSync, writeFileSync } from "node:fs";
import { resetNonceFile } from "../src/reset.ts";

interface SessionStartInput {
  source?: string;
  cwd?: string;
  session_id?: string;
}

const input = JSON.parse(await Bun.stdin.text()) as SessionStartInput;
if (input.source === "clear" && input.cwd && input.session_id) {
  const file = resetNonceFile(input.cwd);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, input.session_id);
  renameSync(tmp, file); // atomic same-dir replace, so the server never reads a partial write
}
