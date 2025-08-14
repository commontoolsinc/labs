// Generic JSON path helpers used by store and query layers

export type JsonPath = string[];

export function getAtPath(root: unknown, path: JsonPath): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (cur == null) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function setAtPath(root: unknown, path: JsonPath, value: unknown): void {
  let cur: unknown = root;
  for (let i = 0; i < path.length; i++) {
    const key = path[i]!;
    const last = i === path.length - 1;
    if (last) {
      (cur as Record<string, unknown>)[key] = value as unknown as never;
    } else {
      const next = (cur as Record<string, unknown>)[key];
      if (next == null || typeof next !== "object") {
        (cur as Record<string, unknown>)[key] = {} as unknown as never;
      }
      cur = (cur as Record<string, unknown>)[key];
    }
  }
}
