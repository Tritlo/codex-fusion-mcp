import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type PermissionOption,
  type RequestPermissionResponse,
  type SessionNotification,
  type Usage,
} from "@agentclientprotocol/sdk";
import type { Config } from "./config.ts";
import { describePermission, guardianDecision } from "./permissions.ts";
import { logTurn } from "./log.ts";

/** Grace after an ACP cancel before we hard-stop a wedged turn and respawn. */
const HARD_STOP_GRACE_MS = 1500;

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

/** A permission Codex raised mid-turn, awaiting Claude's allow/deny. */
interface PendingPermission {
  /** What Codex wants to do, for Claude to judge. */
  description: string;
  /** Resolve the held-open ACP request with Claude's decision. */
  decide: (allow: boolean) => void;
}

/**
 * What {@link CodexSession.ask}/{@link CodexSession.permit} return: either
 * Codex's answer, or a permission request handed back for Claude to judge.
 */
export type TurnOutcome =
  | { type: "answer"; result: AskResult }
  | { type: "permission"; description: string };

/** Internal: the next thing that happens in a running turn. */
type TurnEvent =
  | { kind: "permission"; permission: PendingPermission }
  | { kind: "done"; result: AskResult }
  | { kind: "failed"; error: Error };

/** A point-in-time health snapshot of the Codex session. */
export interface SessionStatus {
  workspaceRoot: string;
  acpCommand: string;
  guardian: { externalReads: boolean; writes: boolean; commands: boolean };
  sessionStarted: boolean;
  childAlive: boolean;
  /** Description of a permission currently awaiting Claude's decision, if any. */
  pendingPermission?: string;
  stderrTail: string;
}

/**
 * A long-lived ACP client over a spawned `codex-acp` process.
 *
 * One session is created lazily on first use and reused for every tool call, so
 * Codex accumulates context across the conversation (the "persistent session"
 * fusion model). Turns are serialized behind a gate. A turn can pause mid-flight
 * when Codex requests a permission guardian doesn't auto-allow: {@link ask}
 * returns a {@link TurnOutcome} of `permission`, and {@link permit} resumes the
 * same suspended turn once Claude has decided.
 */
export class CodexSession {
  private readonly config: Config;
  private child?: ChildProcess;
  private conn?: ClientSideConnection;
  private sessionId?: string;
  private starting?: Promise<void>;
  private readonly stderr: string[] = [];

  // In-flight turn state (safe because turns are serialized behind the gate).
  private turnText = "";
  private turnLog: string[] = [];
  private turnStart = 0;
  private turnLabel = "turn";
  private turnOnText?: (chunk: string) => void;
  private turnOnActivity?: (note: string) => void;

  // Event channel between the ACP callbacks and ask()/permit().
  private eventQueue: TurnEvent[] = [];
  private eventWaiter?: (e: TurnEvent) => void;
  private awaitingDecision?: PendingPermission;

  // Serializes turns; the holder releases it when the turn fully ends.
  private turnGate: Promise<void> = Promise.resolve();
  private releaseGate?: () => void;

  constructor(config: Config) {
    this.config = config;
  }

  private pickOption(options: PermissionOption[], allow: boolean): PermissionOption | undefined {
    const wanted: Array<PermissionOption["kind"]> = allow
      ? ["allow_once", "allow_always"]
      : ["reject_once", "reject_always"];
    return wanted.map((kind) => options.find((o) => o.kind === kind)).find((o) => o !== undefined);
  }

  private buildClient(): Client {
    return {
      requestPermission: async (params): Promise<RequestPermissionResponse> => {
        // Ignore late requests from a superseded session (after a respawn).
        if (params.sessionId !== this.sessionId) return { outcome: { outcome: "cancelled" } };

        const verdict = guardianDecision(params.toolCall, this.config);
        const label = describePermission(params.toolCall);
        if (verdict.decision === "allow") {
          const note = `auto-allowed: ${label}`;
          this.turnLog.push(note);
          this.turnOnActivity?.(note);
          const option = this.pickOption(params.options, true);
          return option
            ? { outcome: { outcome: "selected", optionId: option.optionId } }
            : { outcome: { outcome: "cancelled" } };
        }

        // Hand the decision back to Claude; suspend the turn until permit().
        this.turnOnActivity?.(`needs permission: ${label}`);
        return await new Promise<RequestPermissionResponse>((resolveAcp) => {
          const permission: PendingPermission = {
            description: `${label}${verdict.reason ? `  [${verdict.reason}]` : ""}`,
            decide: (allow) => {
              const option = this.pickOption(params.options, allow);
              resolveAcp(
                option
                  ? { outcome: { outcome: "selected", optionId: option.optionId } }
                  : { outcome: { outcome: "cancelled" } },
              );
            },
          };
          this.pushEvent({ kind: "permission", permission });
        });
      },
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        if (params.sessionId !== this.sessionId) return; // drop stale-session updates
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
    // If codex-acp dies, drop the session so the next turn respawns it.
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
      // Don't leak the half-started subprocess; reset so the next call respawns.
      if (this.child === child) {
        this.child = undefined;
        this.conn = undefined;
        this.sessionId = undefined;
      }
      child.kill();
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

  /** Start the session, but give up (killing a wedged startup) if `signal` aborts. */
  private async ensureStartedAbortable(signal?: AbortSignal): Promise<boolean> {
    if (this.sessionId) return true;
    if (signal?.aborted) return false;
    const startup = this.ensureStarted();
    if (!signal) {
      await startup;
      return true;
    }
    return await new Promise<boolean>((resolve, reject) => {
      const onAbort = (): void => {
        this.forceReset(); // kill a wedged/half-started child so it can't pin the queue
        resolve(false);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      startup.then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve(true);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }

  // --- event channel ------------------------------------------------------

  private pushEvent(event: TurnEvent): void {
    const waiter = this.eventWaiter;
    if (waiter) {
      this.eventWaiter = undefined;
      waiter(event);
    } else {
      this.eventQueue.push(event);
    }
  }

  private nextEvent(): Promise<TurnEvent> {
    const buffered = this.eventQueue.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise<TurnEvent>((resolve) => {
      this.eventWaiter = resolve;
    });
  }

  // --- turn lifecycle -----------------------------------------------------

  private async acquireGate(): Promise<void> {
    const prev = this.turnGate;
    let release!: () => void;
    this.turnGate = new Promise<void>((r) => (release = r));
    await prev;
    this.releaseGate = release;
  }

  private endTurn(): void {
    this.awaitingDecision = undefined;
    this.eventQueue = [];
    this.eventWaiter = undefined;
    this.turnOnText = undefined;
    this.turnOnActivity = undefined;
    this.releaseGate?.();
    this.releaseGate = undefined;
  }

  private snapshot(stopReason: string, usage?: Usage): AskResult {
    const result: AskResult = {
      text: this.turnText.trim(),
      stopReason,
      log: [...this.turnLog],
      ms: this.turnStart > 0 ? Date.now() - this.turnStart : 0,
      usage,
    };
    logTurn(this.config, {
      tool: this.turnLabel,
      ms: result.ms,
      stopReason,
      totalTokens: usage?.totalTokens,
      activity: result.log,
      text: result.text,
    });
    return result;
  }

  private launchTurn(prompt: string): void {
    this.conn!.prompt({ sessionId: this.sessionId!, prompt: [{ type: "text", text: prompt }] }).then(
      (res) => this.pushEvent({ kind: "done", result: this.snapshot(res.stopReason, res.usage ?? undefined) }),
      (err) => this.pushEvent({ kind: "failed", error: err as Error }),
    );
  }

  /** Start a new prompt turn. Returns Codex's answer or a permission to judge. */
  async ask(prompt: string, opts: AskOptions = {}): Promise<TurnOutcome> {
    // A prior turn suspended awaiting a decision Claude never made — abandon it.
    if (this.releaseGate) {
      this.forceReset();
      this.endTurn();
    }
    await this.acquireGate();
    this.turnLabel = opts.label ?? "turn";
    this.turnText = "";
    this.turnLog = [];
    this.turnStart = Date.now();
    this.eventQueue = [];
    this.eventWaiter = undefined;
    try {
      const ok = await this.ensureStartedAbortable(opts.signal);
      if (!ok) {
        const result = this.snapshot("cancelled");
        this.endTurn();
        return { type: "answer", result };
      }
    } catch (err) {
      this.endTurn();
      throw err;
    }
    this.launchTurn(prompt);
    return this.drive(opts);
  }

  /** Resolve the pending permission and resume the suspended turn. */
  async permit(allow: boolean, opts: AskOptions = {}, note?: string): Promise<TurnOutcome> {
    const permission = this.awaitingDecision;
    if (!permission) throw new Error("no pending permission to decide");
    this.awaitingDecision = undefined;
    this.turnLog.push(`${allow ? "allowed" : "denied"} by claude${note ? `: ${note}` : ""}`);
    permission.decide(allow);
    return this.drive(opts);
  }

  /** Wait for the next turn event, applying streaming, cancel, and timeout. */
  private async drive(opts: AskOptions): Promise<TurnOutcome> {
    this.turnOnText = opts.onText;
    this.turnOnActivity = opts.onActivity;

    const ctrl = new AbortController();
    const onExternalAbort = (): void => ctrl.abort();
    opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, this.config.turnTimeoutMs);

    // On abort, ask codex-acp to cancel, then arm a hard stop: ACP cancel is only
    // a notification, so a wedged agent could otherwise keep the turn pending.
    let hardStop = false;
    const abandoned = new Promise<never>((_, reject) => {
      const arm = (): void => {
        const id = this.sessionId;
        if (id) this.conn?.cancel({ sessionId: id }).catch(() => {});
        setTimeout(() => {
          hardStop = true;
          reject(new Error("hard stop after cancel grace"));
        }, HARD_STOP_GRACE_MS);
      };
      if (ctrl.signal.aborted) arm();
      else ctrl.signal.addEventListener("abort", arm, { once: true });
    });

    const clearSegment = (): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onExternalAbort);
      this.turnOnText = undefined;
      this.turnOnActivity = undefined;
    };

    try {
      const event = await Promise.race([this.nextEvent(), abandoned]);
      if (event.kind === "permission") {
        // Suspend: keep the turn open; the wait for Claude's decision isn't timed.
        this.awaitingDecision = event.permission;
        clearSegment();
        return { type: "permission", description: event.permission.description };
      }
      if (event.kind === "failed") {
        clearSegment();
        if (ctrl.signal.aborted) {
          const result = this.snapshot(timedOut ? "timeout" : "cancelled");
          this.endTurn();
          return { type: "answer", result };
        }
        this.endTurn();
        throw event.error;
      }
      clearSegment();
      this.endTurn();
      return { type: "answer", result: event.result };
    } catch (err) {
      if (hardStop || ctrl.signal.aborted) {
        if (hardStop) this.forceReset();
        const result = this.snapshot(timedOut ? "timeout" : "cancelled");
        clearSegment();
        this.endTurn();
        return { type: "answer", result };
      }
      clearSegment();
      this.endTurn();
      throw err;
    }
  }

  /** Kill the subprocess and drop the session so the next turn respawns cleanly. */
  private forceReset(): void {
    const child = this.child;
    this.child = undefined;
    this.conn = undefined;
    this.sessionId = undefined;
    this.starting = undefined;
    child?.kill();
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
      pendingPermission: this.awaitingDecision?.description,
      stderrTail: this.stderr.join("").trim().slice(-600),
    };
  }

  /** Terminate the codex-acp subprocess. */
  dispose(): void {
    this.child?.kill();
  }
}
