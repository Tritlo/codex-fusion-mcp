#!/usr/bin/env bun
/**
 * A scripted ACP *agent* for tests. It's a real subprocess speaking ACP over
 * stdio, so {@link AcpSession} can be exercised end-to-end and deterministically
 * (real spawn, real ndjson framing, real permission round-trips) without a live
 * Codex/Grok. The behavior is chosen by `--scenario <name>`.
 *
 * It must never write to stdout except ACP framing (stdout is the protocol
 * channel); diagnostics go to stderr.
 */
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type RequestPermissionRequest,
} from "@agentclientprotocol/sdk";

const scenarioFlag = process.argv.indexOf("--scenario");
const scenario = scenarioFlag >= 0 ? (process.argv[scenarioFlag + 1] ?? "answer") : "answer";
/** When set, append a byte per newSession so a test can count session creations. */
const sessionsFile = process.env.FAKE_ACP_SESSIONS_FILE;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

let cancelled = false;

new AgentSideConnection((conn): Agent => {
  return {
    async initialize() {
      return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
    },
    async newSession() {
      if (sessionsFile) appendFileSync(sessionsFile, "x");
      return { sessionId: "fake-session" };
    },
    async authenticate() {
      return {};
    },
    async cancel() {
      cancelled = true;
    },
    async prompt(params) {
      cancelled = false;
      const sessionId = params.sessionId;
      const say = (text: string): Promise<void> =>
        conn.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        });
      const think = (text: string): Promise<void> =>
        conn.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } },
        });
      const ask = (toolCall: RequestPermissionRequest["toolCall"]) =>
        conn.requestPermission({
          sessionId,
          toolCall,
          options: [
            { optionId: "allow", kind: "allow_once", name: "Allow" },
            { optionId: "reject", kind: "reject_once", name: "Reject" },
          ],
        });
      const writeCall = { toolCallId: "w1", kind: "edit", title: "write FOO", locations: [{ path: `${process.cwd()}/FOO` }] } as const;

      switch (scenario) {
        case "answer": {
          await think("pondering");
          await say("Hello from fake [ANSWER]");
          return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 32, totalTokens: 42 } };
        }
        case "permission": {
          const res = await ask(writeCall);
          const ok = res.outcome.outcome === "selected" && res.outcome.optionId === "allow";
          await say(ok ? "WROTE-FOO" : "BLOCKED-FOO");
          return { stopReason: "end_turn" };
        }
        case "readonly-probe": {
          // A read *outside* the workspace (so it's an "ask", not an in-workspace
          // auto-allow) and a write — read-only council mode should allow the
          // former and deny the latter, both inline (no suspend).
          await ask({ toolCallId: "r1", kind: "read", title: "read outside", locations: [{ path: "/etc/hosts" }] });
          await ask(writeCall);
          await say("PROBED");
          return { stopReason: "end_turn" };
        }
        case "wedge": {
          // Never resolves and ignores cancel — forces idle-timeout and hard-stop.
          await new Promise<never>(() => {});
          return { stopReason: "end_turn" }; // unreachable
        }
        case "graceful-cancel": {
          for (let i = 0; i < 1200; i++) {
            if (cancelled) return { stopReason: "cancelled" };
            await sleep(25);
          }
          return { stopReason: "end_turn" };
        }
        case "crash": {
          await say("partial");
          await sleep(10);
          process.exit(1);
        }
        // eslint-disable-next-line no-fallthrough
        default: {
          await say(`unknown scenario ${scenario}`);
          return { stopReason: "end_turn" };
        }
      }
    },
  };
}, stream);
