/** Unit tests for the pure council-convergence logic. */
import { expect, test } from "bun:test";
import { councilSettlement, parseVerdict } from "../src/council.ts";

test("parseVerdict reads the VERDICT and CHANGED lines (tolerant of markup)", () => {
  expect(parseVerdict("body\nCHANGED: NO\nVERDICT: CONSENSUS — agreed")).toEqual({ kind: "consensus", changed: false });
  expect(parseVerdict("body\n**VERDICT:** OPEN — still unsure")).toEqual({ kind: "open", changed: null });
  expect(parseVerdict("> CHANGED: yes")).toEqual({ kind: null, changed: true });
  expect(parseVerdict("no markers here")).toEqual({ kind: null, changed: null });
});

test("settled when every answering advisor reports CONSENSUS", () => {
  const s = councilSettlement(2, [
    { name: "Codex", text: "…\nVERDICT: CONSENSUS — yes" },
    { name: "Grok", text: "…\nCHANGED: NO\nVERDICT: CONSENSUS — yes" },
  ]);
  expect(s.done).toBe(true);
  if (s.done) expect(s.kind).toBe("settled");
});

test("an errored/empty advisor doesn't poison the decision, but an all-empty round isn't settled", () => {
  const s = councilSettlement(2, [
    { name: "Codex", text: "" },
    { name: "Grok", text: "VERDICT: CONSENSUS — yes" },
  ]);
  expect(s.done).toBe(true); // decided among the advisors that actually answered

  const allEmpty = councilSettlement(2, [
    { name: "Codex", text: "" },
    { name: "Grok", text: "  " },
  ]);
  expect(allEmpty.done).toBe(false);
});

test("stalemate when no answering advisor's position moved", () => {
  const s = councilSettlement(3, [
    { name: "Codex", text: "…\nCHANGED: NO\nVERDICT: OPEN — x" },
    { name: "Grok", text: "…\nCHANGED: no\nVERDICT: OPEN — y" },
  ]);
  expect(s.done).toBe(true);
  if (s.done) expect(s.kind).toBe("stalemate");
});

test("keep deliberating while positions are still moving or mixed", () => {
  const s = councilSettlement(2, [
    { name: "Codex", text: "…\nCHANGED: YES\nVERDICT: OPEN — x" },
    { name: "Grok", text: "…\nCHANGED: NO\nVERDICT: OPEN — y" },
  ]);
  expect(s.done).toBe(false);
});
