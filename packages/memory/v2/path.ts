/**
 * Parses a JSON Pointer (RFC 6901) string into its segment array, decoding
 * `~1` → `/` and `~0` → `~`. Inverse of `encodePointer()`.
 */
export const parsePointer = (path: string): string[] => {
  if (path === "") {
    return [];
  }
  if (!path.startsWith("/")) {
    throw new Error(`invalid JSON pointer: ${path}`);
  }
  return path.slice(1).split("/").map((segment) =>
    segment.replaceAll("~1", "/").replaceAll("~0", "~")
  );
};

/**
 * Encodes a path-segment array as a JSON Pointer (RFC 6901): empty path
 * becomes `""`, otherwise each segment is escaped (`~` → `~0`, `/` → `~1`)
 * and segments are joined with leading and inter-segment `/`. Inverse of
 * `parsePointer()`.
 *
 * Used both as a wire format (the `path` field of RFC 6902 JSON Patch
 * operations is a JSON Pointer) and as a canonical "logical-path → string"
 * Map-key form within this codebase.
 */
export const encodePointer = (path: readonly string[]): string => {
  return path.length === 0
    ? ""
    : `/${
      path.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1"))
        .join("/")
    }`;
};

export const isPrefixPath = (
  prefix: readonly string[],
  path: readonly string[],
): boolean => {
  if (prefix.length > path.length) {
    return false;
  }
  return prefix.every((segment, index) => path[index] === segment);
};

export const pathsOverlap = (
  left: readonly string[],
  right: readonly string[],
): boolean => isPrefixPath(left, right) || isPrefixPath(right, left);

/**
 * String-form counterpart to `pathsOverlap`, operating directly on JSON
 * Pointer strings (as produced by `encodePointer()`). Two pointers overlap
 * iff one is a strict prefix of the other at a `/` boundary, or they are
 * equal, or either is the root `""`. Lets callers compare pre-encoded keys
 * (e.g. `Map<string, ...>` keys) without round-tripping through
 * `parsePointer()`, which would otherwise allocate per comparison.
 */
export const pathStringsOverlap = (a: string, b: string): boolean => {
  if (a === b) return true;
  if (a === "" || b === "") return true;
  // Both non-empty pointers start with "/". Either string is on the other's
  // chain iff one is a prefix of the other AND the next character on the
  // longer string is "/" (i.e. a true segment boundary, not e.g. "/foo" vs.
  // "/foobar").
  if (a.length < b.length) return b.startsWith(a) && b[a.length] === "/";
  return a.startsWith(b) && a[b.length] === "/";
};

export const parentPath = (path: readonly string[]): string[] => {
  return path.length === 0 ? [] : [...path.slice(0, -1)];
};
