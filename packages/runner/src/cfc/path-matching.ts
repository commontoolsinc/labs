function toCanonicalSegments(path: string): string[] {
  if (path === "/") {
    return [];
  }
  const trimmed = path.startsWith("/") ? path.slice(1) : path;
  if (trimmed.length === 0) {
    return [];
  }
  return trimmed.split("/").filter((segment) => segment.length > 0);
}

/**
 * Returns true when `labelPath` can apply to `readPath`.
 *
 * `labelPath` supports `*` as a wildcard segment (schema-level "any member")
 * and must be equal to, or a prefix of, `readPath`.
 */
export function canonicalLabelPathMatchesReadPath(
  labelPath: string,
  readPath: string,
): boolean {
  const labelSegments = toCanonicalSegments(labelPath);
  const readSegments = toCanonicalSegments(readPath);

  if (labelSegments.length > readSegments.length) {
    return false;
  }

  for (let index = 0; index < labelSegments.length; index++) {
    const labelSegment = labelSegments[index];
    const readSegment = readSegments[index];
    if (labelSegment === "*") {
      continue;
    }
    if (labelSegment !== readSegment) {
      return false;
    }
  }

  return true;
}
