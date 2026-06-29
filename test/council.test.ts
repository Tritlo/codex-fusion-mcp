/** Unit tests for the pure council-selection logic. */
import { expect, test } from "bun:test";
import { selectCouncil } from "../src/council.ts";

test("selectCouncil: no request → the default active council", () => {
  expect(selectCouncil(undefined, ["codex", "grok"])).toEqual(["codex", "grok"]);
  expect(selectCouncil([], ["codex", "grok"])).toEqual(["codex", "grok"]);
});

test("selectCouncil: explicit request is honored, deduped, in canonical (active) order", () => {
  expect(selectCouncil(["grok"], ["codex", "grok"])).toEqual(["grok"]);
  expect(selectCouncil(["grok", "codex", "grok"], ["codex", "grok"])).toEqual(["codex", "grok"]);
});

test("selectCouncil: the host can't be made to consult itself (intersected with active)", () => {
  // Claude is host → not in active; naming it is simply dropped.
  expect(selectCouncil(["claude", "codex"], ["codex", "grok"])).toEqual(["codex"]);
});
