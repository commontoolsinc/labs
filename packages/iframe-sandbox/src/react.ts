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

function loadingQuery<Row>(): QuerySnapshot<Row> {
  return { status: "loading", rows: undefined, error: undefined };
}

/** Builds hooks against the React instance already used by the guest app. */
export function createFabricReact(react: ReactHooks, client: FabricClient) {
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
      (next: T | ((current: T) => T)) =>
        typeof next === "function"
          ? cell.update(next as (current: T) => T)
          : cell.write(next),
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
    const activeQuery = react.useRef<string | undefined>(undefined);
    const generations = react.useRef(new Map<string, number>());
    const [states, setStates] = react.useState<Map<string, QuerySnapshot<Row>>>(
      () => new Map([[queryKey, loadingQuery()]]),
    );
    const snapshot = states.get(queryKey) ?? loadingQuery<Row>();

    const refresh = react.useCallback(async () => {
      if (activeQuery.current !== queryKey) return;
      const request = (generations.current.get(queryKey) ?? 0) + 1;
      generations.current.set(queryKey, request);
      setStates((current) => {
        const next = new Map(current);
        next.set(queryKey, loadingQuery());
        return next;
      });
      try {
        const result = await database.query<Row>(sql, params);
        if (request !== generations.current.get(queryKey)) return;
        setStates((current) => {
          const next = new Map(current);
          next.set(queryKey, {
            status: "ready",
            rows: result.rows,
            error: undefined,
          });
          return next;
        });
      } catch (cause) {
        if (request !== generations.current.get(queryKey)) return;
        setStates((current) => {
          const next = new Map(current);
          next.set(queryKey, {
            status: "error",
            rows: undefined,
            error: cause instanceof Error ? cause : new Error(String(cause)),
          });
          return next;
        });
      }
    }, [database, sql, paramsKey, queryKey]);

    react.useEffect(() => {
      activeQuery.current = queryKey;
      const unsubscribe = database.subscribeInvalidation(() => void refresh());
      void refresh();
      return () => {
        if (activeQuery.current === queryKey) activeQuery.current = undefined;
        generations.current.set(
          queryKey,
          (generations.current.get(queryKey) ?? 0) + 1,
        );
        unsubscribe();
      };
    }, [database, queryKey, refresh]);

    return { ...snapshot, refresh };
  }

  return { useCell, useSqliteQuery };
}
