/**
 * Capability tokens — permission declarations.
 * Plugins declare what they need; the kernel enforces them.
 */

import { z } from "zod";

/**
 * All known capability tokens.
 */
export const CapabilitySet = [
  "fs.read",
  "fs.write",
  "fs.delete",
  "proc.exec",
  "net.http",
  "env.read",
  "model.call",
  "secrets.read",
] as const;

export type Capability = (typeof CapabilitySet)[number];

export const CapabilitySchema = z.enum(CapabilitySet);

export type Capabilities = Set<Capability>;
