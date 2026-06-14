import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { Config } from "./config.ts";
import { guardianDecision } from "./permissions.ts";

/** The outcome of one Codex prompt turn. */
export interface AskResult {
  /** Codex's assembled final message. */
  text: string;
  /** ACP stop reason (`end_turn` when Codex finished normally). */
  stopReason: string;
  /** Guardian decisions and tool calls observed during the turn. */
  log: string[];
}

/**
 * A long-lived ACP client over a spawned `codex-acp` process.
 *
 * One session is created lazily on first use and reused for every tool call,
 * so Codex accumulates context across the conversation (the "persistent
 * session" fusion model). Prompt turns are serialized: callers await {@link
 * ask}, and turns never interleave on the single session.
 */
export class CodexSession {
  private readonly config: Config;
  private child?: ChildProcess;
  private conn?: ClientSideConnection;
  private sessionId?: string;
  private starting?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly stderr: string[] = [];

  // Accumulators for the in-flight turn (safe because turns are serialized).
  private turnText = "";
  private turnLog: string[] = [];

  constructor(config: Config) {
    this.config = config;
  }

  private buildClient(): Client {
    return {
      requestPermission: async (params): Promise<RequestPermissionResponse> => {
        const decision = guardianDecision(params.toolCall, this.config);
        const label = params.toolCall.title ?? params.toolCall.kind ?? "action";
        this.turnLog.push(`${decision.allow ? "approved" : "denied"}: ${label} — ${decision.reason}`);
        const wanted: Array<"allow_once" | "allow_always" | "reject_once" | "reject_always"> =
          decision.allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
        const option = wanted
          .map((kind) => params.options.find((o) => o.kind === kind))
          .find((o) => o !== undefined);
        if (!option) return { outcome: { outcome: "cancelled" } };
        return { outcome: { outcome: "selected", optionId: option.optionId } };
      },
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        const u = params.update;
        switch (u.sessionUpdate) {
          case "agent_message_chunk":
            if (u.content.type === "text") this.turnText += u.content.text;
            break;
          case "tool_call":
            this.turnLog.push(`tool: ${u.title ?? u.kind ?? u.toolCallId}`);
            break;
          default:
            break;
        }
      },
    };
  }

  private async start(): Promise<void> {
    const [cmd, ...args] = this.config.acpCommand;
    if (!cmd) throw new Error("CODEX_FUSION_ACP_COMMAND is empty");

    const child = spawn(cmd, args, {
      cwd: this.config.workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.on("error", (err) => this.stderr.push(`spawn error: ${err.message}`));
    child.stderr?.on("data", (d: Buffer) => {
      this.stderr.push(d.toString());
      if (this.stderr.length > 50) this.stderr.shift();
    });
    if (!child.stdin || !child.stdout) throw new Error("codex-acp: no stdio pipes");

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const conn = new ClientSideConnection(() => this.buildClient(), stream);
    this.conn = conn;

    try {
      await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const session = await conn.newSession({ cwd: this.config.workspaceRoot, mcpServers: [] });
      this.sessionId = session.sessionId;
    } catch (err) {
      const tail = this.stderr.join("").trim().slice(-600);
      throw new Error(
        `codex-acp failed to start a session: ${(err as Error).message}` +
          (tail ? `\n\ncodex-acp stderr:\n${tail}` : "") +
          `\n\nIf this is an auth problem, run \`/codex:setup\` or \`codex login\`.`,
      );
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.sessionId) return;
    this.starting ??= this.start();
    await this.starting;
  }

  /** Send one prompt to Codex and collect its reply. Turns are serialized. */
  async ask(prompt: string): Promise<AskResult> {
    const run = this.queue.then(async (): Promise<AskResult> => {
      await this.ensureStarted();
      this.turnText = "";
      this.turnLog = [];
      const res = await this.conn!.prompt({
        sessionId: this.sessionId!,
        prompt: [{ type: "text", text: prompt }],
      });
      return { text: this.turnText.trim(), stopReason: res.stopReason, log: [...this.turnLog] };
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Terminate the codex-acp subprocess. */
  dispose(): void {
    this.child?.kill();
  }
}
