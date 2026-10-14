/**
 * Tool contract — atomic actions the model can invoke.
 * Every tool declares the capabilities it needs; the kernel enforces them.
 */

import { z } from "zod";
import type { Capability } from "./capabilities.js";
import type { PluginContext } from "./context.js";

export const ToolResultOkSchema = z.object({
  ok: z.literal(true),
  content: z.string(),
  data: z.unknown().optional(),
  meta: z.record(z.unknown()).optional(),
});

export const ToolResultErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  code: z.string().optional(),
  retryable: z.boolean().optional(),
});

export const ToolResultSchema = z.discriminatedUnion("ok", [
  ToolResultOkSchema,
  ToolResultErrorSchema,
]);

/** Standardised error codes for tool results. Use these instead of raw strings so typos surface at compile time. */
export const ToolErrorCodeSet = [
  "ABORTED",
  "FILE_NOT_FOUND",
  "NOT_FOUND",
  "IS_DIRECTORY",
  "STALE",
  "UNKNOWN_TOOL",
  "UNKNOWN",
  "CAPABILITY_DENIED",
  "SCHEMA_ERROR",
  "POLICY_DENIED",
  "POLICY_HALT",
  "EXECUTION_ERROR",
  "TIMEOUT",
  "COMMAND_FAILED",
  "READ_ONLY_VIOLATION",
  "DANGEROUS_PATTERN",
  "INVALID_CWD",
  "FILE_EXISTS",
  "SIZE_EXCEEDED",
  "WRITE_ERROR",
  "NO_MATCH",
  "NO_PATH",
  "NO_GRAPH",
  "MISSING_SECRET",
  "SEARCH_ERROR",
  "FETCH_ERROR",
  "RATE_LIMIT",
] as const;

export const ToolErrorCodeSchema = z.enum(ToolErrorCodeSet);
export type ToolErrorCode = (typeof ToolErrorCodeSet)[number];

export type ToolResult<R = unknown> =
  | { ok: true; content: string; data?: R; meta?: Record<string, unknown> }
  | { ok: false; error: string; code?: ToolErrorCode; retryable?: boolean };

export interface ToolDefinition<A = unknown, R = unknown> {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<A>;
  readonly capabilities: readonly Capability[];
  /** Cannot run in parallel with other tools. */
  readonly exclusive?: boolean;
  execute(
    args: A,
    ctx: PluginContext,
    signal: AbortSignal,
  ): Promise<ToolResult<R>>;
}

/** A tool as presented to the model — no execute, no capabilities leaked. */
export interface ToolView {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<unknown>;
}

/** Minimal JSON Schema shape — ensures at minimum a top-level `type` field. */
export type JsonSchema = Record<string, unknown> & { type: string };

/* ------------------------------------------------------------------ *
 * Zod → JSON Schema
 *
 * The stack pins Zod 3.x, which has neither `schema.jsonSchema()` nor
 * `z.toJSONSchema()`. Without a converter, every tool would advertise an
 * empty parameter object and models would never call them correctly. This
 * is a small, dependency-free walker over Zod's `_def` covering the subset
 * the tool contracts actually use.
 * ------------------------------------------------------------------ */

interface ZodDefLike {
  typeName?: string;
  [key: string]: unknown;
}

function defOf(schema: z.ZodType<unknown>): ZodDefLike {
  return (schema as unknown as { _def: ZodDefLike })._def;
}

function descriptionOf(schema: z.ZodType<unknown>): string | undefined {
  return (schema as unknown as { description?: string }).description;
}

function convert(schema: z.ZodType<unknown>): Record<string, unknown> {
  const def = defOf(schema);
  const out = convertByType(def);
  const desc = descriptionOf(schema);
  if (desc) out.description = desc;
  return out;
}

function convertByType(def: ZodDefLike): Record<string, unknown> {
  switch (def.typeName) {
    case "ZodString":
      return stringSchema(def);
    case "ZodNumber":
      return numberSchema(def);
    case "ZodBigInt":
      return { type: "integer" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodDate":
      return { type: "string", format: "date-time" };
    case "ZodLiteral":
      return { const: def.value };
    case "ZodEnum":
      return { type: "string", enum: [...((def.values as unknown[]) ?? [])] };
    case "ZodNativeEnum":
      return {
        enum: Object.values((def.values as Record<string, unknown>) ?? {}),
      };
    case "ZodArray":
      return {
        type: "array",
        items: convert(def.type as z.ZodType<unknown>),
      };
    case "ZodTuple": {
      const items = (def.items as z.ZodType<unknown>[]) ?? [];
      return {
        type: "array",
        items: items.map((i) => convert(i)),
        minItems: items.length,
        maxItems: items.length,
      };
    }
    case "ZodRecord":
      return {
        type: "object",
        additionalProperties: convert(def.valueType as z.ZodType<unknown>),
      };
    case "ZodObject":
      return objectSchema(def);
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = (def.options as z.ZodType<unknown>[]) ?? [];
      return { anyOf: options.map((o) => convert(o)) };
    }
    case "ZodIntersection":
      return {
        allOf: [
          convert(def.left as z.ZodType<unknown>),
          convert(def.right as z.ZodType<unknown>),
        ],
      };
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
    case "ZodReadonly":
    case "ZodBranded":
    case "ZodCatch":
      return convert(def.innerType as z.ZodType<unknown> ?? def.schema as z.ZodType<unknown>);
    case "ZodEffects":
      return convert(def.schema as z.ZodType<unknown>);
    case "ZodLazy": {
      const getter = def.getter as (() => z.ZodType<unknown>) | undefined;
      return getter ? convert(getter()) : {};
    }
    case "ZodAny":
    case "ZodUnknown":
      return {};
    case "ZodNull":
      return { type: "null" };
    case "ZodUndefined":
      return {};
    default:
      return {};
  }
}

function objectSchema(def: ZodDefLike): Record<string, unknown> {
  const shapeFn = def.shape;
  const shape =
    typeof shapeFn === "function"
      ? (shapeFn as () => Record<string, z.ZodType<unknown>>)()
      : ((shapeFn as Record<string, z.ZodType<unknown>>) ?? {});
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    properties[key] = convert(value);
    if (!isOptional(defOf(value))) required.push(key);
  }
  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

function isOptional(def: ZodDefLike): boolean {
  return def.typeName === "ZodOptional" || def.typeName === "ZodDefault";
}

interface ZodCheck {
  kind: string;
  value?: number;
  regex?: RegExp;
}

function checksOf(def: ZodDefLike): ZodCheck[] {
  return (def.checks as ZodCheck[]) ?? [];
}

function stringSchema(def: ZodDefLike): Record<string, unknown> {
  const out: Record<string, unknown> = { type: "string" };
  for (const c of checksOf(def)) {
    if (c.kind === "min") out.minLength = c.value;
    else if (c.kind === "max") out.maxLength = c.value;
    else if (c.kind === "email") out.format = "email";
    else if (c.kind === "url") out.format = "uri";
    else if (c.kind === "uuid") out.format = "uuid";
    else if (c.kind === "regex" && c.regex) out.pattern = c.regex.source;
  }
  return out;
}

function numberSchema(def: ZodDefLike): Record<string, unknown> {
  const out: Record<string, unknown> = { type: "number" };
  for (const c of checksOf(def)) {
    if (c.kind === "int") out.type = "integer";
    else if (c.kind === "min") out.minimum = c.value;
    else if (c.kind === "max") out.maximum = c.value;
    else if (c.kind === "positive") out.exclusiveMinimum = 0;
    else if (c.kind === "nonnegative") out.minimum = 0;
    else if (c.kind === "negative") out.exclusiveMaximum = 0;
  }
  return out;
}

/**
 * Convert a Zod schema to a JSON Schema-compatible object. Always includes a
 * `type` field; falls back to `{ type: "object" }` for unsupported shapes.
 */
export function toJsonSchema(schema: z.ZodType<unknown>): JsonSchema {
  try {
    const result = convert(schema);
    if (typeof result.type !== "string") result.type = "object";
    return result as JsonSchema;
  } catch {
    return { type: "object", properties: {} };
  }
}
