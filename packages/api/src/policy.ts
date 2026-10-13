/**
 * Policy contract — hooks that can inspect and modify the loop.
 * A policy may veto a step, halt the task, or patch state.
 */

import { z } from "zod";
import type { TaskState } from "./task.js";
import type { Bus, Event } from "./bus.js";

export const PolicyDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("continue") }),
  z.object({ action: z.literal("veto"), reason: z.string() }),
  z.object({ action: z.literal("halt"), reason: z.string() }),
  z
    .object({
      action: z.literal("mutate"),
      patch: z.custom<Partial<TaskState>>(),
    })
    .strict(),
]);

export type PolicyDecision =
  | { action: "continue" }
  | { action: "veto"; reason: string }
  | { action: "halt"; reason: string }
  | { action: "mutate"; patch: Partial<TaskState> };

export interface Policy {
  readonly name: string;
  beforeStep?(state: TaskState, bus: Bus): Promise<PolicyDecision>;
  onEvent?(e: Event, state: TaskState, bus: Bus): Promise<void>;
}
