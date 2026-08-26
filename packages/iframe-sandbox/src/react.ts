/**
 * Adapts iframe bridge resources to the React instance owned by a guest app.
 * The adapter takes hooks structurally, so React stays a guest dependency.
 */

import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { hashStringOf } from "@commonfabric/data-model/value-hash";

import {
  type FabricClient,
  type ResourceSnapshot,
  type SqliteQueryInput,
} from "./guest.ts";

type DependencyList = readonly unknown[];

/** React hooks required by the bridge adapter. */
export type ReactHooks = {
  useCallback<T extends (...args: never[]) => unknown>(
    callback: T,
    dependencies: DependencyList,
  ): T;
  useEffect(
    effect: () => void | (() => void),
    dependencies?: DependencyList,
  ): void;
  useMemo<T>(factory: () => T, dependencies: DependencyList): T;
  useRef<T>(initial: T): { current: T };
  useState<T>(
    initial: T | (() => T),
  ): [T, (value: T | ((current: T) => T)) => void];
  useSyncExternalStore<T>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ): T;
};

/** Reactive state and mutations returned for a bridged cell. */
export type CellHookResult<T> = ResourceSnapshot<T> & {
  set(value: T | ((current: T) => T)): Promise<void>;
  refresh(): Promise<T>;
};

/** Reactive state returned for a bridged SQLite query. */
export type QuerySnapshot<Row> =
  | { status: "loading"; rows: undefined; error: undefined }
  | { status: "ready"; rows: Row[]; error: undefined }
  | { status: "error"; rows: undefined; error: Error };

type KeyedQuerySnapshot<Row> = {
  key: string;
  snapshot: QuerySnapshot<Row>;
};

function loadingQuery<Row>(): QuerySnapshot<Row> {
  return { status: "loading", rows: undefined, error: undefined };
}

/** Builds hooks against the React instance already used by the guest app. */
export function createFabricReact(react: ReactHooks, client: FabricClient) {
  const writeTails = new WeakMap<object, Promise<void>>();

  function useCell<T = FabricValue>(
    name: string,
  ): CellHookResult<T> {
    const cell = react.useMemo(() => client.cell<T>(name), [name]);
    const snapshot = react.useSyncExternalStore(
      (notify) => cell.subscribe(() => notify()),
      cell.getSnapshot,
      cell.getSnapshot,
    );
    react.useEffect(() => {
      if (cell.getSnapshot().status === "loading") {
        void cell.read().catch(() => {});
      }
    }, [cell]);

    const set = react.useCallback(
      (next: T | ((current: T) => T)) => {
        const write = async () => {
          const current = cell.getSnapshot();
          const value = typeof next === "function"
            ? (next as (current: T) => T)(
              current.status === "ready" ? current.value : await cell.read(),
            )
            : next;
          await cell.write(value);
        };
        const previous = writeTails.get(cell);
        const writing = previous ? previous.then(write) : write();
        const tail = writing.catch(() => {});
        writeTails.set(cell, tail);
        void tail.then(() => {
          if (writeTails.get(cell) === tail) {
            writeTails.delete(cell);
          }
        });
        return writing;
      },
      [cell],
    );

    return {
      ...snapshot,
      set,
      refresh: () => cell.read(),
    };
  }

  function useSqliteQuery<Row = Record<string, unknown>>(
    name: string,
    sql: string,
    params?: SqliteQueryInput["params"],
  ): QuerySnapshot<Row> & { refresh(): Promise<void> } {
    const database = react.useMemo(() => client.sqlite(name), [name]);
    const paramsKey = hashStringOf(params ?? null);
    const queryKey = hashStringOf({ name, sql, params: params ?? null });
    const generation = react.useRef(0);
    const [state, setState] = react.useState<KeyedQuerySnapshot<Row>>({
      key: queryKey,
      snapshot: loadingQuery(),
    });
    const snapshot = state.key === queryKey
      ? state.snapshot
      : loadingQuery<Row>();

    const refresh = react.useCallback(async () => {
      const request = ++generation.current;
      setState({ key: queryKey, snapshot: loadingQuery() });
      try {
        const result = await database.query<Row>(sql, params);
        if (request !== generation.current) return;
        setState({
          key: queryKey,
          snapshot: {
            status: "ready",
            rows: result.rows,
            error: undefined,
          },
        });
      } catch (cause) {
        if (request !== generation.current) return;
        setState({
          key: queryKey,
          snapshot: {
            status: "error",
            rows: undefined,
            error: cause instanceof Error ? cause : new Error(String(cause)),
          },
        });
      }
    }, [database, sql, paramsKey, queryKey]);

    react.useEffect(() => {
      const unsubscribe = database.subscribeInvalidation(() => void refresh());
      void refresh();
      return () => {
        generation.current++;
        unsubscribe();
      };
    }, [database, refresh]);

    return { ...snapshot, refresh };
  }

  return { useCell, useSqliteQuery };
}
