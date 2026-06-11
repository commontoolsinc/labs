import { isCellHandle } from "@commonfabric/runtime-client";

/**
 * Tag name the worker reconciler treats as a CFC render boundary. Must match
 * `CFC_RENDER_BOUNDARY_TAG` in `packages/html/src/worker/reconciler.ts`, which
 * identifies boundary nodes by `node.name`.
 */
const CFC_RENDER_BOUNDARY_TAG = "cf-cfc-render-boundary";

/**
 * Refuse to certify pathologically deep trees as boundary-free: past this
 * depth the scan gives up and reports "may contain" (fail closed).
 */
const MAX_SCAN_DEPTH = 64;

/**
 * Conservatively detect whether a vdom value may contain a
 * `<cf-cfc-render-boundary>` node.
 *
 * The worker renderer enforces the CFC render policy for boundary nodes
 * (blocking over-labeled children behind a "Content hidden by policy"
 * placeholder), but the legacy main-thread renderer used for plain-VNode
 * input has no CFC awareness and would render the boundary's children
 * unguarded. Callers on the legacy path (e.g. drag previews) use this scan to
 * fall back to a generic presentation instead of rendering such trees.
 *
 * The scan walks everything synchronously reachable: arrays, vnode children,
 * props (reactive props can carry vdom), `$UI` chains, and the cached values
 * of nested `CellHandle`s. It errs toward `true`: an uninspectable cell
 * (`get()` throws) or an over-deep tree counts as "may contain".
 *
 * Known limit, in line with this being a conservative presence check: a
 * nested cell with no cached value scans as boundary-free, so a boundary that
 * only streams in later through a cell subscription is not detected. (Nested
 * handles materialized from a parent `get()` start without cached values, so
 * treating them as positives would flag virtually every piece UI.)
 */
export function mayContainCfcRenderBoundary(value: unknown): boolean {
  return scan(value, new Set(), 0);
}

function scan(value: unknown, visited: Set<object>, depth: number): boolean {
  if (value === null || typeof value !== "object") return false;
  if (depth >= MAX_SCAN_DEPTH) return true;
  if (visited.has(value)) return false;
  visited.add(value);

  if (isCellHandle(value)) {
    let resolved: unknown;
    try {
      resolved = value.get();
    } catch {
      // The renderer would still try to render this cell; refuse to certify
      // what we cannot inspect.
      return true;
    }
    return scan(resolved, visited, depth + 1);
  }

  if (Array.isArray(value)) {
    return value.some((entry) => scan(entry, visited, depth + 1));
  }

  const record = value as Record<string, unknown>;
  // Flag on the node name alone (no `type === "vnode"` requirement): the
  // legacy renderer is lenient about shape, and a false positive only costs
  // the fancy preview.
  if (record.name === CFC_RENDER_BOUNDARY_TAG) return true;

  // Generic recursion covers `children`, `props` values, and `$UI` chains.
  for (const key of Object.keys(record)) {
    if (scan(record[key], visited, depth + 1)) return true;
  }
  return false;
}
