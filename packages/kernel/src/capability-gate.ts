/**
 * Capability gate — Rule #2 enforcement.
 *
 * Before a tool call executes, the kernel checks that the caller has the
 * capabilities the tool declares. This module is pure and side-effect-free
 * so it can be unit-tested in isolation.
 */
import type { Capability } from "@kli/api";

export class CapabilityError extends Error {
  override readonly name = "CapabilityError";
  constructor(
    readonly tool: string,
    readonly missing: readonly string[],
  ) {
    super(
      `Tool "${tool}" requires capabilities not held by the caller: ${missing.join(", ")}`,
    );
  }
}

/** True if every held capability is present in `granted`. */
export function hasCapabilities(
  held: readonly Capability[],
  granted: ReadonlySet<string>,
): boolean {
  for (const c of held) {
    if (!granted.has(c)) return false;
  }
  return true;
}
