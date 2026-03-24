/**
 * Test utility: creates real CellHandle instances backed by a mock cell
 * network. The returned handles pass `isCellHandle()` (which uses
 * `instanceof CellHandle`) and support get/set/subscribe/key without
 * needing a live RuntimeClient or worker.
 *
 * ## Features
 *
 * - `createMockCellHandle(value)` — basic mock, same as before
 * - Parent-child propagation: when a child from `cell.key("foo")` calls
 *   `.set(v)`, the parent's value is updated and its subscribers fire
 * - `pushUpdate(cell, value)` — simulate a backend push via `$onCellUpdate`,
 *   letting tests distinguish local writes from runtime-originated updates
 */

import {
  $conn,
  $onCellUpdate,
  CellHandle,
  type CellRef,
  type InitializedRuntimeConnection,
  type RuntimeClient,
} from "@commonfabric/runtime-client";

/** Default CellRef used when none is provided. */
const DEFAULT_REF: CellRef = {
  id: "of:mock-cell" as CellRef["id"],
  space: "did:key:mock" as CellRef["space"],
  path: [],
  type: "application/json" as CellRef["type"],
  schema: { type: "object" },
};

/**
 * Registry that tracks root CellHandles, enabling child→parent propagation.
 *
 * When a child CellHandle (created via `parent.key("foo")`) calls `.set()`,
 * the mock connection intercepts the CellSet request, finds the root handle,
 * deep-sets the nested value, and calls `$onCellUpdate` to propagate the
 * change — mirroring what the real runtime does.
 */
class MockCellNetwork {
  /** Root handles keyed by "id:space" */
  #roots = new Map<string, CellHandle>();

  register(handle: CellHandle): void {
    this.#roots.set(this.#rootKey(handle.ref()), handle);
  }

  #rootKey(ref: CellRef): string {
    return `${ref.id}:${ref.space}`;
  }

  /**
   * Handle a CellSet request: propagate child writes to the root handle.
   */
  handleCellSet(
    cellRef: CellRef,
    value: unknown,
  ): void {
    const root = this.#roots.get(this.#rootKey(cellRef));
    if (!root || cellRef.path.length === 0) return;

    // Reconstruct the root's full value with the nested path updated
    const rootValue = root.get();
    if (rootValue == null || typeof rootValue !== "object") return;

    const updated = deepSet(
      rootValue as Record<string, unknown>,
      cellRef.path as string[],
      value,
    );
    root[$onCellUpdate](updated);
  }
}

/** Immutable deep-set: returns a new object with path set to value. */
function deepSet(
  obj: Record<string, unknown>,
  path: string[],
  value: unknown,
): Record<string, unknown> {
  if (path.length === 0) return value as Record<string, unknown>;
  const [head, ...rest] = path;
  const child = obj[head];
  const nested = rest.length === 0 ? value : deepSet(
    (child != null && typeof child === "object" ? child : {}) as Record<
      string,
      unknown
    >,
    rest,
    value,
  );
  if (Array.isArray(obj)) {
    const copy = [...obj];
    copy[Number(head)] = nested;
    return copy as unknown as Record<string, unknown>;
  }
  return { ...obj, [head]: nested };
}

/**
 * Create a mock InitializedRuntimeConnection backed by a MockCellNetwork.
 *
 * - `request()` intercepts CellSet to propagate child→parent writes,
 *   then resolves with `{}`.
 * - `subscribe()` / `unsubscribe()` are no-ops.
 * - Includes EventEmitter stubs (`on`, `off`, `emit`) to satisfy the type.
 */
function createMockConnection(
  network: MockCellNetwork,
): InitializedRuntimeConnection {
  return {
    request: (data: { type: string; cell?: CellRef; value?: unknown }) => {
      if (data.type === "cell:set" && data.cell && data.value !== undefined) {
        network.handleCellSet(data.cell, data.value);
      }
      return Promise.resolve({} as any);
    },
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
 * Create a real CellHandle backed by a mock cell network.
 *
 * The returned handle:
 * - passes `isCellHandle()` (`instanceof CellHandle`)
 * - `.get()` returns the initial value
 * - `.set(v)` updates `.get()` and fires subscribers synchronously
 * - `.subscribe(cb)` calls `cb` immediately with the current value
 * - `.key("foo")` returns a child CellHandle
 * - child `.set()` propagates back to the parent (and fires parent subscribers)
 * - can receive simulated backend pushes via `pushUpdate(handle, value)`
 */
export function createMockCellHandle<T>(
  value?: T,
  ref?: Partial<CellRef>,
): CellHandle<T> {
  const network = new MockCellNetwork();
  const conn = createMockConnection(network);
  const rt = createMockRuntimeClient(conn);
  const cellRef: CellRef = { ...DEFAULT_REF, ...ref };
  const handle = new CellHandle<T>(rt, cellRef, value);
  network.register(handle as CellHandle<unknown>);
  return handle;
}

/**
 * Simulate a backend-pushed value update on a CellHandle.
 *
 * This calls `$onCellUpdate` directly, which is the same code path the real
 * RuntimeConnection uses when the runtime pushes a cell update. Use this to
 * test how components react to external value changes (as opposed to local
 * writes via `.set()`).
 *
 * @example
 * ```ts
 * const cell = createMockCellHandle("initial");
 * cell.subscribe((v) => console.log("got:", v));
 * pushUpdate(cell, "from-backend");
 * // subscriber fires with "from-backend"
 * ```
 */
export function pushUpdate<T>(handle: CellHandle<T>, value: T): void {
  handle[$onCellUpdate](value);
}
