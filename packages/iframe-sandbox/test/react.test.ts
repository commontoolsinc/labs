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

  it("serializes updater writes from separate hooks for the same cell", async () => {
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
    const { useCell } = createFabricReact(hooks, client);
    const firstHook = useCell<Counter>("count");
    const secondHook = useCell<Counter>("count");

    const first = firstHook.set((value) => ({ count: value.count + 1 }));
    const second = secondHook.set((value) => ({ count: value.count + 1 }));
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
    const other = {
      ...remote,
      getSnapshot: () => ({
        status: "ready",
        value: { count: 100 },
      } as const),
    };
    const client = {
      cell: (name: string) => name === "count" ? remote : other,
    } as unknown as FabricClient;
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
    const { useCell } = createFabricReact(hooks, client);
    const render = (name: string) => {
      refIndex = 0;
      return useCell<Counter>(name);
    };

    const first = render("count").set((value) => ({ count: value.count + 1 }));
    await firstStarted.promise;
    render("discarded");
    const second = render("count").set((value) => ({ count: value.count + 1 }));
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

  it("returns loading when the SQLite query identity changes", async () => {
    const aliceReady = Promise.withResolvers<void>();
    const databases = {
      alice: {
        query: () => Promise.resolve({ rows: [{ owner: "alice" }] }),
        subscribeInvalidation: () => () => {},
      },
      bob: {
        query: () => Promise.resolve({ rows: [{ owner: "bob" }] }),
        subscribeInvalidation: () => () => {},
      },
    };
    const client = {
      sqlite: (name: keyof typeof databases) => databases[name],
    } as unknown as FabricClient;
    const refs: Array<{ current: unknown }> = [];
    const states: unknown[] = [];
    let refIndex = 0;
    let stateIndex = 0;
    let effects: Array<() => void | (() => void)> = [];
    const hooks: ReactHooks = {
      useCallback: (callback) => callback,
      useEffect: (effect) => effects.push(effect),
      useMemo: (factory) => factory(),
      useRef: (initial) => {
        const index = refIndex++;
        refs[index] ??= { current: initial };
        return refs[index] as { current: typeof initial };
      },
      useState: (initial) => {
        const index = stateIndex++;
        states[index] ??= typeof initial === "function"
          ? (initial as () => unknown)()
          : initial;
        return [
          states[index],
          (next: unknown) => {
            states[index] = typeof next === "function"
              ? (next as (current: unknown) => unknown)(states[index])
              : next;
            if (
              (states[index] as { snapshot?: { status?: string } }).snapshot
                ?.status === "ready"
            ) {
              aliceReady.resolve();
            }
          },
        ] as never;
      },
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    };
    const { useSqliteQuery } = createFabricReact(hooks, client);
    const render = (name: string) => {
      refIndex = 0;
      stateIndex = 0;
      effects = [];
      return useSqliteQuery(name, "SELECT owner FROM notes");
    };

    expect(render("alice").status).toBe("loading");
    effects[0]?.();
    await aliceReady.promise;
    expect(render("alice")).toMatchObject({
      status: "ready",
      rows: [{ owner: "alice" }],
    });

    const bob = render("bob");
    expect(bob).toMatchObject({
      status: "loading",
      rows: undefined,
      error: undefined,
    });
    expect(typeof bob.refresh).toBe("function");
  });
});
