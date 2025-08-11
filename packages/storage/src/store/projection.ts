/**
 * project(docBytes, paths) – project a saved Automerge doc to JSON and
 * selectively include only provided path subtrees. If paths is empty or
 * undefined, returns full JSON.
 */
import * as Automerge from "@automerge/automerge";
import { getAtPath, setAtPath } from "../json/path.ts";

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
