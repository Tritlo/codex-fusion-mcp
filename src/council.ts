/**
 * Pure helper for selecting who sits on the council. Kept side-effect-free and
 * separate from the MCP server so it's unit-testable without spawning anything
 * (functional core, imperative shell).
 */
import type { MemberId } from "./config.ts";

/**
 * Resolve who participates in a `consult`: with no explicit request, the default
 * council (`active` — the advisors, i.e. the members other than the host); with a
 * request, just those of them (intersected with `active`, in canonical order, so
 * the host can never be made to consult itself).
 */
export function selectCouncil(requested: MemberId[] | undefined, active: MemberId[]): MemberId[] {
  if (!requested || requested.length === 0) return active;
  return active.filter((id) => requested.includes(id));
}
