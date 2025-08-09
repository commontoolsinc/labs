/**
 * project(docBytes, paths) – project a saved Automerge doc to JSON and
 * selectively include only provided path subtrees. If paths is empty or
 * undefined, returns full JSON.
 */
import * as Automerge from "@automerge/automerge";

export function project(docBytes: Uint8Array, paths?: string[][]): Uint8Array {
  const doc = Automerge.load(docBytes);
  const json = Automerge.toJS(doc);
  const projected = paths && paths.length > 0 ? projectJson(json, paths) : json;
  return new TextEncoder().encode(JSON.stringify(projected));
}

function projectJson(root: unknown, paths: string[][]): unknown {
  const out: any = Array.isArray(root) ? [] : {};
  for (const p of paths) {
    setAtPath(out, p, getAtPath(root as any, p));
  }
  return out;
}

function getAtPath(obj: any, path: string[]): any {
  let cur = obj;
  for (const key of path) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function setAtPath(obj: any, path: string[], value: any): void {
  let cur = obj;
  for (let i = 0; i < path.length; i++) {
    const key = path[i]!;
    const isLast = i === path.length - 1;
    if (isLast) {
      cur[key] = value;
    } else {
      const next = cur[key];
      if (next == null || typeof next !== "object") {
        cur[key] = {};
      }
      cur = cur[key];
    }
  }
}
