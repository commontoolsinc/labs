export function isIndex(token: string): boolean {
  return Number.isInteger(Number(token));
}

export function getAtPathWithPrefix(
  root: unknown,
  path: string[],
): { value: unknown; valid: string[] } {
  if (path.length === 0) return { value: root, valid: [] };
  let cur: unknown = root;
  const valid: string[] = [];
  for (const key of path) {
    if (cur == null || typeof cur !== "object") break;
    const idx = isIndex(key) ? Number(key) : undefined;
    if (
      Array.isArray(cur) && idx !== undefined && idx >= 0 && idx < cur.length
    ) {
      cur = (cur as unknown[])[idx];
      valid.push(key);
      continue;
    }
    const obj = cur as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      cur = obj[key];
      valid.push(key);
      continue;
    }
    break;
  }
  if (valid.length !== path.length) return { value: undefined, valid };
  return { value: cur, valid };
}
