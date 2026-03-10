function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string");
}

/**
 * Produces a collision-safe string key for a path.
 */
export function encodePath(path: readonly string[]): string {
  return JSON.stringify(path);
}

/**
 * Decodes a serialized path key produced by {@link encodePath}.
 */
export function decodePath(path: string): readonly string[] {
  if (!path) return [];
  const parsed = JSON.parse(path);
  if (isStringArray(parsed)) {
    return parsed;
  }
  return [];
}

export function uniquePaths(
  paths: readonly (readonly string[])[],
): readonly (readonly string[])[] {
  const seen = new Set<string>();
  const out: (readonly string[])[] = [];
  for (const path of paths) {
    const key = encodePath(path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}
