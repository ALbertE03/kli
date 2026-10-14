/**
 * Skills — high-level capabilities that bundle a prompt + tools (§4.9).
 *
 * This module is the single source of truth for the skill contracts. Prompt
 * fragments live in `prompt.ts`; skills live here. Previously the two were
 * duplicated across both files — do not reintroduce that.
 */

import { z } from "zod";
import { CapabilitySchema } from "./capabilities.js";

export const SkillTriggerKeywordSchema = z.object({
  type: z.literal("keyword"),
  patterns: z.array(z.string()),
});

export const SkillTriggerFileSchema = z.object({
  type: z.literal("file"),
  globs: z.array(z.string()),
});

export const SkillTriggerCommandSchema = z.object({
  type: z.literal("command"),
  command: z.string(),
});

export const SkillTriggerManualSchema = z.object({ type: z.literal("manual") });

export const SkillTriggerSchema = z.discriminatedUnion("type", [
  SkillTriggerKeywordSchema,
  SkillTriggerFileSchema,
  SkillTriggerCommandSchema,
  SkillTriggerManualSchema,
]);

export type SkillTrigger = z.infer<typeof SkillTriggerSchema>;

export const SkillManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  triggers: z.array(SkillTriggerSchema),
  tools: z.array(z.string()),
  prompt: z.string(),
  capabilities: z.array(CapabilitySchema),
});

export type SkillManifest = z.infer<typeof SkillManifestSchema>;
