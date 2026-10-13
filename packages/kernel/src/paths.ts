/**
 * Path safety — Rule #3 enforcement.
 *
 * All paths leaving plugins MUST pass through `resolve(p)`, which validates
 * the result stays inside `workspaceRoot`.
 */
import { join } from "path";

export class PathViolationError extends Error {
  override readonly name = "PathViolationError";
  constructor(
    readonly input: string,
    readonly resolved: string,
    readonly root: string,
  ) {
    super(`Path "${input}" resolves to "${resolved}" which escapes "${root}"`);
  }
}

/**
 * Resolve `p` against `root` and guarantee the canonical result stays
 * inside `root`. Rejects traversal (..) that would escape.
 */
export function resolvePath(p: string, root: string): string {
  if (p.includes("..")) {
    throw new PathViolationError(p, p, root);
  }
  const normalized = p
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
  const resolved = join(root, normalized).replace(/\/+/g, "/");

  const boundary = root.endsWith("/") ? root : `${root}/`;
  if (resolved !== root && !resolved.startsWith(boundary)) {
    throw new PathViolationError(p, resolved, root);
  }
  return resolved;
}
