/**
 * Test utility: creates real CellHandle instances backed by no-op mock
 * connections. The returned handles pass `isCellHandle()` (which uses
 * `instanceof CellHandle`) and support get/set/subscribe/key without
 * needing a live RuntimeClient or worker.
 */

import {
  $conn,
  CellHandle,
  type CellRef,
  type InitializedRuntimeConnection,
  type RuntimeClient,
} from "@commontools/runtime-client";

/** Default CellRef used when none is provided. */
const DEFAULT_REF: CellRef = {
  id: "of:mock-cell" as CellRef["id"],
  space: "did:key:mock" as CellRef["space"],
  path: [],
  type: "application/json" as CellRef["type"],
  schema: { type: "object" },
};

/**
 * Create a mock InitializedRuntimeConnection.
 *
 * - `request()` resolves immediately with `{}` (CellHandle.set() updates the
 *   local cache *before* calling request, so tests see value changes
 *   synchronously).
 * - `subscribe()` / `unsubscribe()` are no-ops.
 * - Includes EventEmitter stubs (`on`, `off`, `emit`) to satisfy the type.
 */
function createMockConnection(): InitializedRuntimeConnection {
  return {
    request: () => Promise.resolve({} as any),
    subscribe: () => Promise.resolve(),
    unsubscribe: () => Promise.resolve(),
    on: () => ({}) as any,
    off: () => ({}) as any,
    once: () => ({}) as any,
    emit: () => false,
    removeAllListeners: () => ({}) as any,
    listenerCount: () => 0,
  } as unknown as InitializedRuntimeConnection;
}

/**
 * Create a mock RuntimeClient that only provides `[$conn]()`.
 *
 * CellHandle's constructor only accesses `worker[$conn]()` — it doesn't call
 * any other RuntimeClient methods — so this minimal mock is sufficient.
 */
function createMockRuntimeClient(
  conn: InitializedRuntimeConnection,
): RuntimeClient {
  return { [$conn]: () => conn } as unknown as RuntimeClient;
}

/**
 * Create a real CellHandle backed by no-op mocks.
 *
 * The returned handle:
 * - passes `isCellHandle()` (`instanceof CellHandle`)
 * - `.get()` returns the initial value
 * - `.set(v)` updates `.get()` and fires subscribers synchronously
 * - `.subscribe(cb)` calls `cb` immediately with the current value
 * - `.key("foo")` returns a child CellHandle
 */
export function createMockCellHandle<T>(
  value?: T,
  ref?: Partial<CellRef>,
): CellHandle<T> {
  const conn = createMockConnection();
  const rt = createMockRuntimeClient(conn);
  const cellRef: CellRef = { ...DEFAULT_REF, ...ref };
  return new CellHandle<T>(rt, cellRef, value);
}
