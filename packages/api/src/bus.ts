/**
 * Events — the only allowed cross-plugin channel (Rule #5).
 * The bus is synchronous; handlers never see each other's errors.
 */

import { z } from "zod";
import { PluginKindSchema } from "./manifest.js";
import { ModeSchema } from "./mode.js";

export const TaskStartedSchema = z.object({
  type: z.literal("task.started"),
  taskId: z.string(),
  mode: ModeSchema,
});

export const ModeChangedSchema = z.object({
  type: z.literal("mode.changed"),
  from: ModeSchema,
  to: ModeSchema,
});

export const PluginLoadedSchema = z.object({
  type: z.literal("plugin.loaded"),
  id: z.string(),
  version: z.string(),
  kind: z.array(PluginKindSchema),
});

export const PluginRejectedSchema = z.object({
  type: z.literal("plugin.rejected"),
  id: z.string(),
  reason: z.string(),
});

export const PluginReloadedSchema = z.object({
  type: z.literal("plugin.reloaded"),
  id: z.string(),
});

export const McpServerConnectedSchema = z.object({
  type: z.literal("mcp.server.connected"),
  name: z.string(),
});

export const McpServerFailedSchema = z.object({
  type: z.literal("mcp.server.failed"),
  name: z.string(),
  error: z.string(),
});

export const SkillActivatedSchema = z.object({
  type: z.literal("skill.activated"),
  id: z.string(),
  reason: z.string(),
});

export const ToolCalledSchema = z.object({
  type: z.literal("tool.called"),
  name: z.string(),
  argsHash: z.string(),
});

export const ToolCompletedSchema = z.object({
  type: z.literal("tool.completed"),
  name: z.string(),
  ok: z.boolean(),
  ms: z.number(),
});

export const ToolProgressSchema = z.object({
  type: z.literal("tool.progress"),
  name: z.string(),
  chunk: z.string(),
});

export const ModelRequestSchema = z.object({
  type: z.literal("model.request"),
  tokens: z.number(),
});

export const ModelResponseSchema = z.object({
  type: z.literal("model.response"),
  tokens: z.number(),
  cost: z.number(),
});

export const ContextCompactedSchema = z.object({
  type: z.literal("context.compacted"),
  before: z.number(),
  after: z.number(),
});

export const PolicyTriggeredSchema = z.object({
  type: z.literal("policy.triggered"),
  name: z.string(),
  reason: z.string(),
});

export const TaskFinishedSchema = z.object({
  type: z.literal("task.finished"),
  status: z.enum(["ok", "error", "halted"]),
  cost: z.number(),
});

export const EventSchema = z.discriminatedUnion("type", [
  TaskStartedSchema,
  ModeChangedSchema,
  PluginLoadedSchema,
  PluginRejectedSchema,
  PluginReloadedSchema,
  McpServerConnectedSchema,
  McpServerFailedSchema,
  SkillActivatedSchema,
  ToolCalledSchema,
  ToolCompletedSchema,
  ToolProgressSchema,
  ModelRequestSchema,
  ModelResponseSchema,
  ContextCompactedSchema,
  PolicyTriggeredSchema,
  TaskFinishedSchema,
]);

export type Event =
  | z.infer<typeof TaskStartedSchema>
  | z.infer<typeof ModeChangedSchema>
  | z.infer<typeof PluginLoadedSchema>
  | z.infer<typeof PluginRejectedSchema>
  | z.infer<typeof PluginReloadedSchema>
  | z.infer<typeof McpServerConnectedSchema>
  | z.infer<typeof McpServerFailedSchema>
  | z.infer<typeof SkillActivatedSchema>
  | z.infer<typeof ToolCalledSchema>
  | z.infer<typeof ToolCompletedSchema>
  | z.infer<typeof ToolProgressSchema>
  | z.infer<typeof ModelRequestSchema>
  | z.infer<typeof ModelResponseSchema>
  | z.infer<typeof ContextCompactedSchema>
  | z.infer<typeof PolicyTriggeredSchema>
  | z.infer<typeof TaskFinishedSchema>;

export type EventType = Event["type"];

export type Handler<T extends EventType> = (
  e: Extract<Event, { type: T }>,
) => void;

export interface Bus {
  emit(e: Event): void;
  on<T extends EventType>(type: T, handler: Handler<T>): () => void;
}
