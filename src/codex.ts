import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type RequestPermissionResponse,
  type SessionNotification,
  type Usage,
} from "@agentclientprotocol/sdk";
import type { Config } from "./config.ts";
import { guardianDecision } from "./permissions.ts";
import { logTurn } from "./log.ts";

/** The outcome of one Codex prompt turn. */
export interface AskResult {
  /** Codex's assembled final message. */
  text: string;
  /** ACP stop reason (`end_turn` when Codex finished normally; also `timeout`/`cancelled`). */
  stopReason: string;
  /** Guardian decisions and tool calls observed during the turn (full detail). */
  log: string[];
  /** Wall-clock duration of the turn in ms. */
  ms: number;
  /** Token usage for the turn, when Codex reported it. */
  usage?: Usage;
}

/** Per-turn options: cancellation and live streaming hooks. */
export interface AskOptions {
  /** Tool name, for the debug log. */
  label?: string;
  /** Aborts the turn (e.g. the user cancels); triggers an ACP `session/cancel`. */
  signal?: AbortSignal;
  /** Called with each chunk of Codex's reply as it streams in. */
  onText?: (chunk: string) => void;
  /** Called with each guardian decision / tool call, for a live activity view. */
  onActivity?: (note: string) => void;
}

/** A point-in-time health snapshot of the Codex session. */
export interface SessionStatus {
  workspaceRoot: string;
  acpCommand: string;
  guardian: { externalReads: boolean; writes: boolean; commands: boolean };
  sessionStarted: boolean;
  childAlive: boolean;
  stderrTail: string;
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

  // Accumulators/hooks for the in-flight turn (safe because turns are serialized).
  private turnText = "";
  private turnLog: string[] = [];
  private turnOnText?: (chunk: string) => void;
  private turnOnActivity?: (note: string) => void;

  constructor(config: Config) {
    this.config = config;
  }

  private buildClient(): Client {
    return {
      requestPermission: async (params): Promise<RequestPermissionResponse> => {
        const decision = guardianDecision(params.toolCall, this.config);
        const label = params.toolCall.title ?? params.toolCall.kind ?? "action";
        const note = `${decision.allow ? "approved" : "denied"}: ${label} — ${decision.reason}`;
        this.turnLog.push(note);
        this.turnOnActivity?.(note);
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
            if (u.content.type === "text") {
              this.turnText += u.content.text;
              this.turnOnText?.(u.content.text);
            }
            break;
          case "tool_call": {
            const note = `tool: ${u.title ?? u.kind ?? u.toolCallId}`;
            this.turnLog.push(note);
            this.turnOnActivity?.(note);
            break;
          }
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
    // If codex-acp dies, drop the session so the next ask() respawns it.
    child.on("exit", (code, signal) => {
      this.stderr.push(`codex-acp exited (code=${code} signal=${signal})`);
      if (this.child === child) {
        this.child = undefined;
        this.conn = undefined;
        this.sessionId = undefined;
        this.starting = undefined;
      }
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
    if (!this.starting) {
      this.starting = this.start();
      this.starting.catch(() => {}); // avoid an unhandled rejection before the await below
    }
    try {
      await this.starting;
    } catch (err) {
      this.starting = undefined; // clear the poisoned promise so a later call can retry
      throw err;
    }
  }

  /** Send one prompt to Codex and collect its reply. Turns are serialized. */
  async ask(prompt: string, opts: AskOptions = {}): Promise<AskResult> {
    const run = this.queue.then(() => this.runTurn(prompt, opts));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async runTurn(prompt: string, opts: AskOptions): Promise<AskResult> {
    await this.ensureStarted();
    this.turnText = "";
    this.turnLog = [];
    this.turnOnText = opts.onText;
    this.turnOnActivity = opts.onActivity;
    const started = Date.now();

    // One controller fires on either the caller's cancel or our turn timeout;
    // either way we tell codex-acp to stop the turn.
    const ctrl = new AbortController();
    const onExternalAbort = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, this.config.turnTimeoutMs);
    ctrl.signal.addEventListener(
      "abort",
      () => {
        const id = this.sessionId;
        if (id) this.conn?.cancel({ sessionId: id }).catch(() => {});
      },
      { once: true },
    );

    const finish = (stopReason: string): AskResult => {
      const result: AskResult = {
        text: this.turnText.trim(),
        stopReason,
        log: [...this.turnLog],
        ms: Date.now() - started,
      };
      logTurn(this.config, {
        tool: opts.label ?? "turn",
        ms: result.ms,
        stopReason,
        totalTokens: result.usage?.totalTokens,
        activity: result.log,
        text: result.text,
      });
      return result;
    };

    try {
      const res = await this.conn!.prompt({
        sessionId: this.sessionId!,
        prompt: [{ type: "text", text: prompt }],
      });
      const result = finish(timedOut ? "timeout" : res.stopReason);
      result.usage = res.usage ?? undefined;
      return result;
    } catch (err) {
      // A cancel/timeout often surfaces as a rejected prompt; report it gracefully.
      if (ctrl.signal.aborted) return finish(timedOut ? "timeout" : "cancelled");
      throw err;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onExternalAbort);
      this.turnOnText = undefined;
      this.turnOnActivity = undefined;
    }
  }

  /** Current health, without starting a session. */
  status(): SessionStatus {
    const child = this.child;
    return {
      workspaceRoot: this.config.workspaceRoot,
      acpCommand: this.config.acpCommand.join(" "),
      guardian: {
        externalReads: this.config.allowExternalReads,
        writes: this.config.allowWrites,
        commands: this.config.allowCommands,
      },
      sessionStarted: this.sessionId !== undefined,
      childAlive: child !== undefined && child.exitCode === null && !child.killed,
      stderrTail: this.stderr.join("").trim().slice(-600),
    };
  }

  /** Terminate the codex-acp subprocess. */
  dispose(): void {
    this.child?.kill();
  }
}
