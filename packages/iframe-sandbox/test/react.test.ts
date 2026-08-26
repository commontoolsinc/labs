/** Exercises React-shaped subscriptions and mutations without bundling React. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { FabricClient, ResourceSnapshot } from "../src/guest.ts";
import { createFabricReact, type ReactHooks } from "../src/react.ts";

describe("React bridge adapter", () => {
  it("supports interface-shaped cell values and updater writes", async () => {
    interface Counter {
      count: number;
    }

    const writes: Counter[] = [];
    const reads: string[] = [];
    let snapshot: ResourceSnapshot<Counter> = { status: "loading" };
    const remote = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      read: () => {
        reads.push("read");
        snapshot = { status: "ready", value: { count: 2 } };
        return Promise.resolve({ count: 2 });
      },
      write: (value: Counter) => {
        writes.push(value);
        return Promise.resolve();
      },
    };
    const client = { cell: () => remote } as unknown as FabricClient;
    const effects: Array<() => void | (() => void)> = [];
    const hooks: ReactHooks = {
      useCallback: (callback) => callback,
      useEffect: (effect) => effects.push(effect),
      useMemo: (factory) => factory(),
      useRef: (initial) => ({ current: initial }),
      useState: (initial) =>
        [
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial,
          () => {},
        ] as never,
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    };
    const { useCell } = createFabricReact(hooks, client);

    const counter = useCell<Counter>("counter");
    for (const effect of effects) effect();
    await counter.set((value) => ({ count: value.count + 1 }));

    expect(reads).toEqual(["read"]);
    expect(writes).toEqual([{ count: 3 }]);
  });

  it("serializes overlapping updater writes against the latest snapshot", async () => {
    type Counter = { count: number };
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const writes: Counter[] = [];
    let snapshot: ResourceSnapshot<Counter> = {
      status: "ready",
      value: { count: 1 },
    };
    const remote = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      read: () => Promise.resolve((snapshot as { value: Counter }).value),
      write: async (value: Counter) => {
        writes.push(value);
        if (writes.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        snapshot = { status: "ready", value };
      },
    };
    const client = { cell: () => remote } as unknown as FabricClient;
    const hooks: ReactHooks = {
      useCallback: (callback) => callback,
      useEffect: () => {},
      useMemo: (factory) => factory(),
      useRef: (initial) => ({ current: initial }),
      useState: (initial) =>
        [
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial,
          () => {},
        ] as never,
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    };
    const counter = createFabricReact(hooks, client).useCell<Counter>("count");

    const first = counter.set((value) => ({ count: value.count + 1 }));
    const second = counter.set((value) => ({ count: value.count + 1 }));
    await firstStarted.promise;
    expect(writes).toEqual([{ count: 2 }]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(writes).toEqual([{ count: 2 }, { count: 3 }]);
  });

  it("keeps the write queue when React discards memoized values", async () => {
    type Counter = { count: number };
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const writes: Counter[] = [];
    let snapshot: ResourceSnapshot<Counter> = {
      status: "ready",
      value: { count: 1 },
    };
    const remote = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      read: () => Promise.resolve((snapshot as { value: Counter }).value),
      write: async (value: Counter) => {
        writes.push(value);
        if (writes.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        snapshot = { status: "ready", value };
      },
    };
    const client = { cell: () => remote } as unknown as FabricClient;
    const refs: Array<{ current: unknown }> = [];
    let refIndex = 0;
    const hooks: ReactHooks = {
      useCallback: (callback) => callback,
      useEffect: () => {},
      useMemo: (factory) => factory(),
      useRef: (initial) => {
        const index = refIndex++;
        refs[index] ??= { current: initial };
        return refs[index] as { current: typeof initial };
      },
      useState: (initial) =>
        [
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial,
          () => {},
        ] as never,
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    };
    const render = () => {
      refIndex = 0;
      return createFabricReact(hooks, client).useCell<Counter>("count");
    };

    const first = render().set((value) => ({ count: value.count + 1 }));
    await firstStarted.promise;
    const second = render().set((value) => ({ count: value.count + 1 }));
    await Promise.resolve();
    expect(writes).toEqual([{ count: 2 }]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(writes).toEqual([{ count: 2 }, { count: 3 }]);
  });

  it("invalidates an active SQLite query subscription on cleanup", () => {
    let unsubscribed = false;
    const calls: string[] = [];
    const database = {
      query: () => {
        calls.push("query");
        return Promise.resolve({ rows: [] });
      },
      subscribeInvalidation: () => {
        calls.push("subscribe");
        return () => {
          unsubscribed = true;
        };
      },
    };
    const client = { sqlite: () => database } as unknown as FabricClient;
    const effects: Array<() => void | (() => void)> = [];
    const hooks: ReactHooks = {
      useCallback: (callback) => callback,
      useEffect: (effect) => effects.push(effect),
      useMemo: (factory) => factory(),
      useRef: (initial) => ({ current: initial }),
      useState: (initial) =>
        [
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial,
          () => {},
        ] as never,
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    };
    const { useSqliteQuery } = createFabricReact(hooks, client);

    useSqliteQuery("database", "SELECT 1");
    const cleanup = effects[0]?.();
    expect(calls).toEqual(["subscribe", "query"]);
    expect(typeof cleanup).toBe("function");
    (cleanup as () => void)();
    expect(unsubscribed).toBe(true);
  });
});
