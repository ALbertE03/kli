/**
 * Path safety — Rule #3 enforcement.
 *
 * All paths leaving plugins MUST pass through `resolve(p)`, which validates
 * the result stays inside `workspaceRoot`.
 */
import { posix } from "path";

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
 * Normalize a path string: decode percent-encoding and collapse `.`/`..`
 * segments and duplicate slashes. Uses `posix.normalize` (NOT `posix.resolve`)
 * so that a relative path is not silently anchored to the process CWD.
 */
function normalizePath(p: string): string {
  // Decode percent-encoded dots/slashes so %2e%2e becomes .. and %2f becomes /
  const decoded = p.replace(/%(?:2[Ee]|2[Ff]|5[Cc]|7[Cc])/g, (match) => {
    const lower = match.toLowerCase();
    if (lower === "%2e") return ".";
    if (lower === "%2f") return "/";
    if (lower === "%5c") return "\\";
    return match;
  });
  return posix.normalize(decoded);
}

/**
 * Resolve `p` against `root` and guarantee the canonical result stays
 * inside `root`. Rejects traversal (..) that would escape, including
 * encoded variants like %2e%2e. Absolute inputs are accepted only when they
 * already point inside `root`.
 */
export function resolvePath(p: string, root: string): string {
  const normalizedRoot = posix.normalize(root).replace(/\/+$/, "");
  let rel = normalizePath(p);

  // Absolute input: keep it only if it is already inside the workspace root,
  // then convert back to a root-relative path.
  if (rel.startsWith("/")) {
    if (rel === normalizedRoot) {
      rel = "";
    } else if (rel.startsWith(`${normalizedRoot}/`)) {
      rel = rel.slice(normalizedRoot.length + 1);
    } else {
      throw new PathViolationError(p, rel, root);
    }
  }

  // Reject any remaining traversal after normalization
  if (rel === ".." || rel.startsWith("../")) {
    throw new PathViolationError(p, rel, root);
  }

  const resolved = rel === "" || rel === "." ? normalizedRoot : `${normalizedRoot}/${rel}`;
  const boundary = `${normalizedRoot}/`;
  if (resolved !== normalizedRoot && !resolved.startsWith(boundary)) {
    throw new PathViolationError(p, resolved, root);
  }
  return resolved;
}
