// Generic JSON path helpers used by store and query layers

export type JsonPath = string[];

export function getAtPath(root: any, path: JsonPath): any {
  let cur = root;
  for (const key of path) {
    if (cur == null) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as any)[key];
  }
  return cur;
}

export function setAtPath(root: any, path: JsonPath, value: any): void {
  let cur = root;
  for (let i = 0; i < path.length; i++) {
    const key = path[i]!;
    const last = i === path.length - 1;
    if (last) {
      (cur as any)[key] = value;
    } else {
      const next = (cur as any)[key];
      if (next == null || typeof next !== "object") {
        (cur as any)[key] = {};
      }
      cur = (cur as any)[key];
    }
  }
}


