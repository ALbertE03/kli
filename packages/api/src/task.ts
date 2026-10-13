/**
 * Task state — the agent loop's running record for one invocation.
 */

import { z } from "zod";

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Raw JSON string or parsed object, provider-dependent. */
  args: z.union([z.string(), z.record(z.unknown())]),
});

export type ToolCall = z.infer<typeof ToolCallSchema>;

export const MessageSchema = z.object({
  role: z.union([
    z.literal("system"),
    z.literal("user"),
    z.literal("assistant"),
    z.literal("tool"),
  ]),
  content: z.string(),
  /** Populated on assistant messages that requested tools. */
  toolCalls: z.array(ToolCallSchema).optional(),
  /** Populated on tool result messages. */
  toolCallId: z.string().optional(),
});

export type Message = z.infer<typeof MessageSchema>;

export interface TaskState {
  readonly taskId: string;
  readonly mode: string;
  readonly messages: readonly Message[];
  readonly budget: {
    tokensTotal: number;
    tokensUsed: number;
    costUsd: number;
    costLimitUsd: number;
    deadlineMs: number;
  };
  readonly steps: number;
  readonly done: boolean;
  readonly verificationPassed: boolean;
  readonly lastToolResults: readonly {
    name: string;
    ok: boolean;
    step: number;
  }[];
}
