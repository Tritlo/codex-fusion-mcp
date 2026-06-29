/**
 * End-to-end lifecycle tests for {@link AcpSession}, driven against a real but
 * scripted ACP agent subprocess ({@link file://./fake-acp.ts}). These go through
 * the actual spawn → initialize → newSession → prompt → permission → cancel path,
 * so they exercise the state machine (the project's crown jewel) deterministically.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, MemberSpec } from "../src/config.ts";
import { AcpSession } from "../src/session.ts";
import { resetNonceFile } from "../src/reset.ts";

const FAKE = join(import.meta.dir, "fake-acp.ts");

const spec = (id: MemberSpec["id"], name: string): MemberSpec => ({
  id,
  name,
  promptName: name,
  acpCommand: [],
  commandEnvName: `X_${id}`,
  loginHint: "log in",
});

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    claude: spec("claude", "Claude"),
    codex: spec("codex", "Codex"),
    grok: spec("grok", "Grok"),
    workspaceRoot: process.cwd(),
    allowExternalReads: false,
    allowWrites: false,
    allowCommands: false,
    turnTimeoutMs: 600_000,
    ...overrides,
  };
}

function fakeMember(scenario: string): MemberSpec {
  return {
    id: "codex",
    name: "Fake",
    promptName: "Fake",
    acpCommand: ["bun", "run", FAKE, "--scenario", scenario],
    commandEnvName: "X_codex",
    loginHint: "log in",
  };
}

const live: AcpSession[] = [];
function makeSession(scenario: string, config: Config = baseConfig()): AcpSession {
  const s = new AcpSession(config, fakeMember(scenario));
  live.push(s);
  return s;
}

afterEach(() => {
  while (live.length) live.pop()?.dispose();
});

test("happy turn: streams text + reasoning, reports usage", async () => {
  const s = makeSession("answer");
  let text = "";
  let thought = "";
  const out = await s.ask("hi", { onText: (c) => (text += c), onThought: (c) => (thought += c) });
  expect(out.type).toBe("answer");
  if (out.type !== "answer") return;
  expect(out.result.text).toContain("[ANSWER]");
  expect(out.result.stopReason).toBe("end_turn");
  expect(out.result.usage?.totalTokens).toBe(42);
  expect(text).toContain("[ANSWER]");
  expect(thought).toContain("pondering"); // reasoning streams but never folds into text
  expect(out.result.text).not.toContain("pondering");
});

test("permission suspend → permit allow resumes the same turn", async () => {
  const s = makeSession("permission");
  const o1 = await s.ask("write FOO");
  expect(o1.type).toBe("permission");
  if (o1.type === "permission") expect(o1.description).toContain("write FOO");
  expect(s.isAwaitingPermission()).toBe(true);

  const o2 = await s.permit(true);
  expect(o2.type).toBe("answer");
  if (o2.type === "answer") expect(o2.result.text).toBe("WROTE-FOO");
  expect(s.isAwaitingPermission()).toBe(false);
});

test("permission suspend → permit deny resumes with a denial", async () => {
  const s = makeSession("permission");
  const o1 = await s.ask("write FOO");
  expect(o1.type).toBe("permission");
  const o2 = await s.permit(false);
  expect(o2.type).toBe("answer");
  if (o2.type === "answer") expect(o2.result.text).toBe("BLOCKED-FOO");
});

test("a new ask abandons a suspended turn cleanly (settles the held permission)", async () => {
  const s = makeSession("permission");
  const o1 = await s.ask("write FOO");
  expect(o1.type).toBe("permission");
  // No permit — start a fresh ask. ask() must reset the suspended turn (settling
  // its dangling ACP request) and run the new one without deadlocking the gate.
  const o2 = await s.ask("write FOO again");
  expect(o2.type).toBe("permission");
  expect(s.isAwaitingPermission()).toBe(true);
});

test("explicit reset() clears a suspended turn", async () => {
  const s = makeSession("permission");
  const o1 = await s.ask("write FOO");
  expect(o1.type).toBe("permission");
  s.reset();
  expect(s.isAwaitingPermission()).toBe(false);
});

test("read-only council mode: reads auto-allowed, writes auto-denied, never suspends", async () => {
  const s = makeSession("readonly-probe");
  const out = await s.ask("probe", { onAskPermission: "read-only" });
  expect(out.type).toBe("answer");
  if (out.type !== "answer") return;
  const log = out.result.log.join("\n");
  expect(log).toContain("auto-allowed");
  expect(log).toContain("[read-only]");
  expect(log).toContain("auto-denied");
  expect(out.result.text).toBe("PROBED");
});

test("idle timeout aborts a silent, wedged turn", async () => {
  const s = makeSession("wedge");
  const out = await s.ask("hang", { timeoutMs: 150 });
  expect(out.type).toBe("answer");
  if (out.type === "answer") expect(out.result.stopReason).toBe("timeout");
}, 10_000);

test("external cancel stops a turn", async () => {
  const s = makeSession("graceful-cancel");
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const out = await s.ask("go", { signal: ac.signal });
  expect(out.type).toBe("answer");
  if (out.type === "answer") expect(out.result.stopReason).toBe("cancelled");
}, 10_000);

test("a child that dies mid-turn fails fast, not after the idle timeout", async () => {
  const s = makeSession("crash");
  let threw = false;
  const started = performance.now();
  try {
    await s.ask("go", { timeoutMs: 30_000 }); // huge idle window: if it waited for idle, it'd take 30s+
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
  // Woken by the child's exit, not the idle timeout. The bound is generous (vs the
  // 30s idle window) so a loaded CI box can't flake it while still proving the point.
  expect(performance.now() - started).toBeLessThan(15_000);
}, 25_000);

test("turns serialize behind the gate", async () => {
  const s = makeSession("answer");
  const [a, b] = await Promise.all([s.ask("1"), s.ask("2")]);
  expect(a.type).toBe("answer");
  expect(b.type).toBe("answer");
});

test("a changed reset nonce drops the session and respawns", async () => {
  const ws = mkdtempSync(join(tmpdir(), "magi-nonce-"));
  const sessFile = join(ws, "sessions.log");
  const nonceFile = resetNonceFile(ws);
  writeFileSync(nonceFile, "v1"); // baseline read by the constructor
  process.env.FAKE_ACP_SESSIONS_FILE = sessFile;
  try {
    const s = makeSession("answer", baseConfig({ workspaceRoot: ws }));
    await s.ask("first");
    expect(readFileSync(sessFile, "utf8").length).toBe(1); // one session so far
    writeFileSync(nonceFile, "v2"); // simulate /clear
    await s.ask("second");
    expect(readFileSync(sessFile, "utf8").length).toBe(2); // reset → respawned a new session
  } finally {
    delete process.env.FAKE_ACP_SESSIONS_FILE;
  }
});
