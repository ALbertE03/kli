/**
 * Plugin manifest — the public fingerprint of a plugin.
 */

import { z } from "zod";
import { CapabilitySchema } from "./capabilities.js";

export const PluginKindSet = ["tool", "provider", "context", "policy"] as const;
export type PluginKind = (typeof PluginKindSet)[number];

export const PluginKindSchema = z.enum(PluginKindSet);

export const PluginManifestSchema = z.object({
  id: z
    .string()
    .regex(
      /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/,
      "must be a valid package name (scope/name or name)",
    ),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:-[a-z0-9-.]+)?$/, "must be semver"),
  apiVersion: z.literal("1"),
  kind: z.array(PluginKindSchema).min(1, "at least one kind is required"),
  entrypoint: z.string().startsWith("./", "entrancepath must start with ./"),
  requires: z.array(z.string()).optional(),
  capabilities: z.array(CapabilitySchema),
  priority: z.number().int().min(0).max(1000, "priority must be between 0 and 1000").optional().default(0),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
