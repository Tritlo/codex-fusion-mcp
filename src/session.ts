import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
import type { Config, MemberSpec } from "./config.ts";
import { describePermission, guardianDecision } from "./permissions.ts";
import { logTurn } from "./log.ts";
import { resetNonceFile } from "./reset.ts";

/** Grace after an ACP cancel before we hard-stop a wedged turn and respawn. */
const HARD_STOP_GRACE_MS = 1500;

/**
 * SIGTERM a child, then escalate to SIGKILL after the grace if it's still alive,
 * so a member that ignores SIGTERM can't survive as an orphan. The timer is
 * `unref`'d (it never keeps the host process alive) and cleared if the child
 * exits in time.
 */
/**
 * Resolve symlinks in a path for containment checks, tolerating a target that
 * doesn't exist yet (a write to a new file): realpath the nearest existing
 * ancestor and re-append the remaining segments. So an in-workspace symlink that
 * points outside the workspace resolves to its real location and can't be mistaken
 * for an in-workspace path by a later lexical containment check.
 */
function realPathBestEffort(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return tail.length ? join(realpathSync(cur), ...tail) : realpathSync(cur);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p); // hit the root without resolving — lexical fallback
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

function hardKill(child: ChildProcess): void {
  child.kill(); // SIGTERM
  const sigkill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, HARD_STOP_GRACE_MS);
  if (typeof sigkill.unref === "function") sigkill.unref();
  child.once("exit", () => clearTimeout(sigkill));
}

/**
 * ACP `sessionUpdate` kinds that count as the member making progress, and so reset
 * the idle timeout. Everything else (usage/mode/config/commands/session-info, and
 * the echoed user message) is housekeeping that must not keep a wedged turn alive.
 */
const LIVENESS_UPDATES = new Set<SessionNotification["update"]["sessionUpdate"]>([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

/** Thrown by {@link AcpSession.permit} when no turn is awaiting a decision. */
export class NoPendingPermission extends Error {
  constructor() {
    super("no pending permission to decide");
    this.name = "NoPendingPermission";
  }
}

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
  /** Called with each chunk of Codex's reasoning, for a live "thinking" view. Also
   * the heartbeat that keeps the MCP request alive during long silent reasoning. */
  onThought?: (chunk: string) => void;
  /** Called with each guardian decision / tool call, for a live activity view. */
  onActivity?: (note: string) => void;
  /** Override the idle timeout (ms) for this turn; falls back to the config default. */
  timeoutMs?: number;
  /**
   * How to handle a guardian "ask" verdict for this turn. `"suspend"` (the
   * default) hands the decision back to Claude as a permission and pauses the
   * turn until {@link AcpSession.permit}. `"read-only"` resolves "ask" inline —
   * auto-allowing reads/searches/think/fetch (so members can ground their answer,
   * even outside the workspace) and auto-denying writes and command execution — so
   * the turn never blocks. Used by the magi council, which must complete as a
   * single atomic call but should still be able to read. Reads/searches inside the
   * workspace are auto-allowed in every mode, and Grok's built-in web/X search
   * doesn't go through this path at all.
   */
  onAskPermission?: "suspend" | "read-only";
}

/** A permission Codex raised mid-turn, awaiting Claude's allow/deny. */
interface PendingPermission {
  /** What Codex wants to do, for Claude to judge. */
  description: string;
  /** Resolve the held-open ACP request with Claude's decision. */
  decide: (allow: boolean) => void;
  /** Settle the held-open ACP request as `cancelled` (e.g. the turn is reset
   * before the host decides) so it isn't left dangling. */
  cancel: () => void;
}

/**
 * What {@link AcpSession.ask}/{@link AcpSession.permit} return: either the
 * member's answer, or a permission request handed back for Claude to judge.
 */
export type TurnOutcome =
  | { type: "answer"; result: AskResult }
  | { type: "permission"; description: string };

/** Internal: the next thing that happens in a running turn. */
type TurnEvent =
  | { kind: "permission"; permission: PendingPermission }
  | { kind: "done"; result: AskResult }
  | { kind: "failed"; error: Error };

/** A point-in-time health snapshot of one member's session. */
export interface SessionStatus {
  /** Member display name (e.g. "Codex", "Grok"). */
  name: string;
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
 * A long-lived ACP client over a spawned ACP agent process (Codex or Grok).
 *
 * One session is created lazily on first use and reused for every tool call, so
 * the member accumulates context across the conversation (the "persistent
 * session" fusion model). Turns are serialized behind a gate. A turn can pause
 * mid-flight when the member requests a permission guardian doesn't auto-allow:
 * {@link ask} returns a {@link TurnOutcome} of `permission`, and {@link permit}
 * resumes the same suspended turn once Claude has decided. The {@link MemberSpec}
 * makes the command, env var, and error/login text member-correct.
 */
export class AcpSession {
  private readonly config: Config;
  private readonly member: MemberSpec;
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
  private turnOnThought?: (chunk: string) => void;
  private turnOnActivity?: (note: string) => void;
  // When true, a guardian "ask" verdict is resolved inline (read-only council
  // mode): reads/search/think/fetch allowed, writes/commands denied — never
  // suspends. Set per turn from AskOptions.onAskPermission.
  private turnReadOnly = false;

  // Event channel between the ACP callbacks and ask()/permit().
  private eventQueue: TurnEvent[] = [];
  private eventWaiter?: (e: TurnEvent) => void;
  private awaitingDecision?: PendingPermission;
  // Set by the active drive() segment; the ACP sessionUpdate callback calls it on
  // every chunk so the idle timeout is measured from Codex's *last* output.
  private bumpIdle?: () => void;

  // Serializes turns; the holder releases it when the turn fully ends.
  private turnGate: Promise<void> = Promise.resolve();
  private releaseGate?: () => void;
  // How many ask() calls are queued waiting for the gate. A turn that would
  // suspend on a permission while someone is waiting abandons instead of parking,
  // so the queued ask can't wedge behind a turn that may never be permitted.
  private gateWaiters = 0;
  // Generation token: bumped per turn so stale async work (a force-reset turn's
  // background prompt, or a superseded segment) can't mutate a newer turn.
  private turnId = 0;
  // Last-seen reset nonce; a *change* (the SessionStart hook wrote a new Claude
  // session id on /clear) drops the member's context on the next turn.
  private lastNonce?: string;

  constructor(config: Config, member: MemberSpec) {
    this.config = config;
    this.member = member;
    this.lastNonce = this.readResetNonce(); // baseline — only a later change resets
  }

  /** Member display name (e.g. "Codex", "Grok"). */
  get name(): string {
    return this.member.name;
  }

  /** How to recover from an auth/usage failure (for error messages). */
  get loginHint(): string {
    return this.member.loginHint;
  }

  /** True if a turn is suspended awaiting Claude's permit decision. */
  isAwaitingPermission(): boolean {
    return this.awaitingDecision !== undefined;
  }

  private pickOption(options: PermissionOption[], allow: boolean): PermissionOption | undefined {
    const wanted: Array<PermissionOption["kind"]> = allow
      ? ["allow_once", "allow_always"]
      : ["reject_once", "reject_always"];
    const chosen = wanted.map((kind) => options.find((o) => o.kind === kind)).find((o) => o !== undefined);
    // A one-shot allow that the agent only offers as `allow_always` would silently
    // become a standing grant for this session. Honor it (denying would block a
    // host "allow" entirely), but surface it so the host isn't surprised.
    if (chosen && allow && chosen.kind === "allow_always") {
      const note = "note: agent offered no one-shot allow; granted as allow_always (persists this session)";
      this.turnLog.push(note);
      this.turnOnActivity?.(note);
    }
    return chosen;
  }

  /** True if reading `abs` is allowed: inside the workspace, or external reads enabled.
   * Compares *real* (symlink-resolved) paths so an in-workspace symlink can't point
   * outside the sandbox and escape the read scope. */
  private isReadable(abs: string): boolean {
    if (this.config.allowExternalReads) return true;
    const rel = relative(realPathBestEffort(this.config.workspaceRoot), realPathBestEffort(abs));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }

  private buildClient(): Client {
    return {
      requestPermission: async (params): Promise<RequestPermissionResponse> => {
        // Ignore late requests from a superseded session (after a respawn).
        if (params.sessionId !== this.sessionId) return { outcome: { outcome: "cancelled" } };

        // Resolve symlinks in the requested locations before the (pure) policy
        // sees them, so an in-workspace symlink to outside can't be auto-allowed
        // as "inside the workspace". The human-facing label keeps the original path.
        const locations = params.toolCall.locations;
        const resolvedCall =
          locations && locations.length > 0
            ? { ...params.toolCall, locations: locations.map((l) => ({ ...l, path: realPathBestEffort(l.path) })) }
            : params.toolCall;
        const verdict = guardianDecision(resolvedCall, this.config);
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

        // Read-only council turns never suspend: resolve "ask" inline — allow
        // reads/search/think/fetch (so the member can ground its answer), deny
        // writes and command execution. Logged like an auto-allow so the council
        // renderer can report what was blocked (ADR 0006/0008).
        if (this.turnReadOnly) {
          const kind = params.toolCall.kind ?? "other";
          const readOnlyKind = kind === "read" || kind === "search" || kind === "think" || kind === "fetch";
          const note = readOnlyKind
            ? `auto-allowed: ${label} [read-only]`
            : `auto-denied: ${label}${verdict.reason ? `  [${verdict.reason}]` : ""}`;
          this.turnLog.push(note);
          this.turnOnActivity?.(note);
          const option = this.pickOption(params.options, readOnlyKind);
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
            cancel: () => resolveAcp({ outcome: { outcome: "cancelled" } }),
          };
          this.pushEvent({ kind: "permission", permission });
        });
      },
      readTextFile: async (params) => {
        // Read-only client filesystem: serve reads scoped to the workspace (or
        // anywhere when external reads are enabled). Never writes. This gives the
        // member a non-shell read path that works even in read-only council mode.
        if (params.sessionId !== this.sessionId) throw new Error("read for a superseded session");
        const abs = resolve(params.path);
        if (!this.isReadable(abs)) {
          throw new Error(`read denied: ${params.path} is outside the workspace (set CODEX_FUSION_/MAGI_COUNCIL_ALLOW_EXTERNAL_READS to allow)`);
        }
        let content = readFileSync(abs, "utf8");
        if (params.line != null || params.limit != null) {
          const lines = content.split("\n");
          const start = Math.max(0, (params.line ?? 1) - 1);
          const end = params.limit != null ? start + params.limit : lines.length;
          content = lines.slice(start, end).join("\n");
        }
        const note = `read: ${relative(this.config.workspaceRoot, abs) || abs}`;
        this.turnLog.push(note);
        this.turnOnActivity?.(note);
        return { content };
      },
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        if (params.sessionId !== this.sessionId) return; // drop stale-session updates
        const u = params.update;
        // Real output (text, reasoning, tool progress, plan) resets the idle
        // timeout. Housekeeping updates (usage/mode/config/commands/session-info)
        // are not progress, so they must not keep a wedged turn alive.
        if (LIVENESS_UPDATES.has(u.sessionUpdate)) this.bumpIdle?.();
        switch (u.sessionUpdate) {
          case "agent_message_chunk":
            if (u.content.type === "text") {
              this.turnText += u.content.text;
              this.turnOnText?.(u.content.text);
            } else if (u.content.type === "resource_link") {
              // Generated media (image/video) often arrives as a file link rather
              // than text — surface it so grok_generate can report the path.
              const note = `\n[saved: ${u.content.uri}]\n`;
              this.turnText += note;
              this.turnOnText?.(note);
            }
            break;
          case "agent_thought_chunk":
            // The member's reasoning. Forward only as a live view / heartbeat —
            // emitting progress keeps the MCP request alive through long silent
            // thinking (the client resets its timeout on progress). Never fold it
            // into turnText, which must stay the member's final answer.
            if (u.content.type === "text") this.turnOnThought?.(u.content.text);
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
    const [cmd, ...args] = this.member.acpCommand;
    if (!cmd) throw new Error(`${this.member.commandEnvName} is empty`);

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
    // If the agent dies, drop the session so the next turn respawns it. When
    // `this.child === child` the death was *unexpected* (we null `this.child`
    // before killing in forceReset/startup-cleanup, so those paths don't match);
    // wake any waiting turn with a failure so it fails fast instead of sitting
    // out the idle timeout. A stale event with no turn in flight is harmless —
    // ask() clears the queue before launching.
    child.on("exit", (code, signal) => {
      this.stderr.push(`${this.member.name} exited (code=${code} signal=${signal})`);
      if (this.child === child) {
        this.child = undefined;
        this.conn = undefined;
        this.sessionId = undefined;
        this.starting = undefined;
        this.pushEvent({
          kind: "failed",
          error: new Error(`${this.member.name} exited unexpectedly (code=${code} signal=${signal})`),
        });
      }
    });
    if (!child.stdin || !child.stdout) throw new Error(`${this.member.name}: no stdio pipes`);

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const conn = new ClientSideConnection(() => this.buildClient(), stream);
    this.conn = conn;

    try {
      // Advertise a read-only client filesystem so agents can read files through
      // us (sandboxed to the workspace) instead of shelling out — the only way a
      // command-reader like Codex can read in read-only council mode. We do NOT
      // advertise writeTextFile: writes still go through the guardian.
      await conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
      });
      const session = await conn.newSession({ cwd: this.config.workspaceRoot, mcpServers: [] });
      // If startup was superseded (aborted/timed-out → forceReset, or a respawn)
      // while newSession was in flight, don't bind a session to a dead child.
      if (this.child !== child) throw new Error(`${this.member.name} startup superseded`);
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
        `${this.member.name} (${this.member.acpCommand.join(" ")}) failed to start a session: ${(err as Error).message}` +
          (tail ? `\n\n${this.member.name} stderr:\n${tail}` : "") +
          `\n\nIf this is an auth or usage problem, ${this.member.loginHint}.`,
      );
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.sessionId) return;
    if (!this.starting) {
      this.starting = this.start();
      this.starting.catch(() => {}); // avoid an unhandled rejection before the await below
    }
    const p = this.starting;
    try {
      await p;
    } catch (err) {
      // Only clear *our* poisoned promise: a superseded startup that rejects late
      // must not null a newer start() that a subsequent call already kicked off.
      if (this.starting === p) this.starting = undefined;
      throw err;
    }
  }

  /**
   * Start the session, giving up if `signal` aborts or startup exceeds the
   * **default** turn timeout (a wedged `initialize`/`newSession` must not pin the
   * gate). Startup uses `config.turnTimeoutMs`, not the per-call idle override:
   * a short per-call `time` is meant to bound *silence during a turn*, and must
   * not starve a cold subprocess launch (e.g. a first-run `bunx` fetch). Returns
   * false if cancelled; throws on startup failure or timeout.
   */
  private async ensureStartedAbortable(signal?: AbortSignal): Promise<boolean> {
    if (this.sessionId) return true;
    if (signal?.aborted) return false;
    const limit = this.config.turnTimeoutMs;
    const startup = this.ensureStarted();
    startup.catch(() => {}); // we may stop awaiting it below; don't leak a rejection
    return await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.forceReset();
        reject(new Error(`${this.member.name} startup timed out after ${limit}ms`));
      }, limit);
      const onAbort = (): void => {
        cleanup();
        this.forceReset(); // kill a wedged/half-started child so it can't pin the queue
        resolve(false);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      startup.then(
        () => {
          cleanup();
          resolve(true);
        },
        (err) => {
          cleanup();
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

  /** End turn `id`, releasing the gate and clearing state — a no-op if superseded. */
  private finish(id: number): void {
    if (id !== this.turnId) return; // a newer turn owns the state now; don't touch it
    this.awaitingDecision = undefined;
    this.eventQueue = [];
    this.eventWaiter = undefined;
    this.turnOnText = undefined;
    this.turnOnThought = undefined;
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
      member: this.member.name,
      tool: this.turnLabel,
      ms: result.ms,
      stopReason,
      totalTokens: usage?.totalTokens,
      activity: result.log,
      text: result.text,
    });
    return result;
  }

  private launchTurn(prompt: string, id: number): void {
    this.conn!.prompt({ sessionId: this.sessionId!, prompt: [{ type: "text", text: prompt }] }).then(
      (res) => {
        if (id !== this.turnId) return; // stale completion from a superseded turn
        this.pushEvent({ kind: "done", result: this.snapshot(res.stopReason, res.usage ?? undefined) });
      },
      (err) => {
        if (id !== this.turnId) return;
        this.pushEvent({ kind: "failed", error: err as Error });
      },
    );
  }

  /** Start a new prompt turn. Returns the member's answer or a permission to judge. */
  async ask(prompt: string, opts: AskOptions = {}): Promise<TurnOutcome> {
    this.checkSessionEpoch(); // a new Claude session (/clear) drops the member's stale context
    // A prior turn suspended awaiting a decision Claude never made — abandon it.
    // Key on awaitingDecision (the suspended marker), not releaseGate, which is
    // set for every in-flight turn and would wrongly abandon a running one.
    if (this.awaitingDecision) this.reset();
    this.gateWaiters++;
    try {
      await this.acquireGate();
    } finally {
      this.gateWaiters--;
    }
    const id = ++this.turnId;
    this.turnLabel = opts.label ?? "turn";
    this.turnReadOnly = opts.onAskPermission === "read-only";
    this.turnText = "";
    this.turnLog = [];
    this.turnStart = Date.now();
    this.eventQueue = [];
    this.eventWaiter = undefined;
    try {
      const ok = await this.ensureStartedAbortable(opts.signal);
      if (!ok) {
        const result = this.snapshot("cancelled");
        this.finish(id);
        return { type: "answer", result };
      }
    } catch (err) {
      this.finish(id);
      throw err;
    }
    this.launchTurn(prompt, id);
    return this.drive(opts, id);
  }

  /** Resolve the pending permission and resume the suspended turn. */
  async permit(allow: boolean, opts: AskOptions = {}, note?: string): Promise<TurnOutcome> {
    // If /clear landed between the permission and the decision, reset rather than
    // resume a stale turn; awaitingDecision is then cleared → NoPendingPermission.
    this.checkSessionEpoch();
    const permission = this.awaitingDecision;
    if (!permission) throw new NoPendingPermission();
    this.awaitingDecision = undefined;
    // If the permit call was already cancelled, never approve — downgrade to deny;
    // drive() then observes the abort and cancels the turn.
    const granted = allow && !opts.signal?.aborted;
    this.turnLog.push(`${granted ? "allowed" : "denied"} by host${note ? `: ${note}` : ""}`);
    permission.decide(granted);
    return this.drive(opts, this.turnId); // same generation as the suspended turn
  }

  /** Wait for turn `id`'s next event, applying streaming, cancel, and timeout. */
  private async drive(opts: AskOptions, id: number): Promise<TurnOutcome> {
    this.turnOnText = opts.onText;
    this.turnOnThought = opts.onThought;
    this.turnOnActivity = opts.onActivity;

    const ctrl = new AbortController();
    const onExternalAbort = (): void => ctrl.abort();
    opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (opts.signal?.aborted) ctrl.abort(); // listener won't fire for an already-aborted signal

    // Idle timeout, measured from the member's *last* output: bumpIdle (called from the
    // sessionUpdate callback on every chunk) pushes lastActivity forward, and the
    // timer re-arms for the remaining window instead of firing. An actively-
    // streaming turn is therefore never cut off — only true silence aborts, so a
    // long review/exploration keeps its partial output instead of being killed.
    // Monotonic clock: a wall-clock jump (NTP, laptop/WSL2 suspend-resume) must not
    // make the watchdog fire early and abort a live turn — the exact regression we
    // are removing.
    const timeoutMs = opts.timeoutMs ?? this.config.turnTimeoutMs;
    let timedOut = false;
    let lastActivity = performance.now();
    this.bumpIdle = (): void => {
      lastActivity = performance.now();
    };
    let timer: ReturnType<typeof setTimeout>;
    const armIdle = (): void => {
      const remaining = timeoutMs - (performance.now() - lastActivity);
      if (remaining <= 0) {
        timedOut = true;
        ctrl.abort();
      } else {
        timer = setTimeout(armIdle, remaining);
      }
    };
    timer = setTimeout(armIdle, timeoutMs);

    // On abort, ask the agent to cancel, then arm a hard stop: ACP cancel is only
    // a notification, so a wedged agent could otherwise keep the turn pending.
    let hardStop = false;
    const abandoned = new Promise<never>((_, reject) => {
      const arm = (): void => {
        const sid = this.sessionId;
        if (sid) this.conn?.cancel({ sessionId: sid }).catch(() => {});
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
      // Only a current segment owns the shared callbacks; a superseded segment must
      // not clear them out from under the newer turn that now holds them.
      if (id === this.turnId) {
        this.bumpIdle = undefined;
        this.turnOnText = undefined;
        this.turnOnThought = undefined;
        this.turnOnActivity = undefined;
      }
    };

    const cancelledAnswer = (): TurnOutcome => {
      const result = this.snapshot(timedOut ? "timeout" : "cancelled");
      clearSegment();
      this.finish(id);
      return { type: "answer", result };
    };

    try {
      const event = await Promise.race([this.nextEvent(), abandoned]);
      if (id !== this.turnId) {
        // This segment was superseded; don't touch the newer turn's state.
        clearSegment();
        return { type: "answer", result: { text: "", stopReason: "cancelled", log: [], ms: 0 } };
      }
      if (event.kind === "permission") {
        // If another ask is already queued behind the gate, parking here (the
        // suspended turn holds the gate) would wedge it until this turn is
        // permitted — which may never happen. Abandon instead: cancel the request
        // and finish, releasing the gate so the queued ask takes over. This
        // extends "a new ask abandons a suspended turn" to the concurrent case.
        if (this.gateWaiters > 0) {
          event.permission.cancel();
          clearSegment();
          const result = this.snapshot("cancelled");
          this.finish(id);
          return { type: "answer", result };
        }
        // Suspend: keep the turn open; the wait for Claude's decision isn't timed.
        this.awaitingDecision = event.permission;
        clearSegment();
        return { type: "permission", description: event.permission.description };
      }
      if (event.kind === "failed") {
        if (ctrl.signal.aborted) return cancelledAnswer();
        clearSegment();
        this.finish(id);
        throw event.error;
      }
      clearSegment();
      this.finish(id);
      return { type: "answer", result: event.result };
    } catch (err) {
      if (hardStop || ctrl.signal.aborted) {
        if (id !== this.turnId) {
          clearSegment();
          return { type: "answer", result: { text: "", stopReason: "cancelled", log: [], ms: 0 } };
        }
        if (hardStop) this.forceReset();
        return cancelledAnswer();
      }
      clearSegment();
      this.finish(id);
      throw err;
    }
  }

  /** Contents of the per-workspace reset nonce file, or undefined if absent/unreadable. */
  private readResetNonce(): string | undefined {
    try {
      return readFileSync(resetNonceFile(this.config.workspaceRoot), "utf8") || undefined;
    } catch {
      return undefined; // missing/unreadable is "no change", never reset churn
    }
  }

  /** Reset if the SessionStart hook signalled a new Claude session (/clear). */
  private checkSessionEpoch(): void {
    const nonce = this.readResetNonce();
    if (nonce !== undefined && nonce !== this.lastNonce) {
      this.lastNonce = nonce;
      this.reset();
    }
  }

  /**
   * Drop the member's session and preempt any in-flight or suspended turn, so the
   * next turn starts a brand-new session. Idempotent and safe with no active
   * turn. Backs both the manual `reset` tool and auto-reset on a new Claude
   * session. Must run *before* {@link acquireGate}: a suspended turn deliberately
   * holds the gate, so waiting on it here would deadlock.
   */
  reset(): void {
    this.turnId++; // invalidate the old turn's in-flight async work
    // Settle a held-open permission request (best effort, before we kill the
    // child) so the suspended turn's ACP promise isn't left dangling.
    this.awaitingDecision?.cancel();
    this.forceReset();
    this.awaitingDecision = undefined;
    const waiter = this.eventWaiter;
    this.eventWaiter = undefined;
    waiter?.({ kind: "failed", error: new Error("superseded by session reset") });
    this.eventQueue = [];
    this.releaseGate?.();
    this.releaseGate = undefined;
  }

  /** Kill the subprocess and drop the session so the next turn respawns cleanly.
   * SIGTERM first, then SIGKILL after a grace if the child ignores it — the README
   * promises a real hard stop, and a wedged agent must not survive as an orphan. */
  private forceReset(): void {
    const child = this.child;
    this.child = undefined;
    this.conn = undefined;
    this.sessionId = undefined;
    this.starting = undefined;
    if (child) hardKill(child);
  }

  /** Current health, without starting a session. */
  status(): SessionStatus {
    const child = this.child;
    return {
      name: this.member.name,
      workspaceRoot: this.config.workspaceRoot,
      acpCommand: this.member.acpCommand.join(" "),
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

  /** Terminate the member's ACP subprocess immediately. Used for teardown —
   * ephemeral `fresh` cleanup and process shutdown — where we want the child gone
   * now, not gracefully: SIGKILL directly, since the deferred escalation in
   * {@link hardKill} can't fire when the shutdown handler calls `process.exit`
   * right after. (Mid-session cancels still use the graceful path via forceReset.) */
  dispose(): void {
    this.child?.kill("SIGKILL");
  }
}
