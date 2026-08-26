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

  it("invalidates an active SQLite query subscription on cleanup", () => {
    let unsubscribed = false;
    const database = {
      query: () => Promise.resolve({ rows: [] }),
      subscribeInvalidation: () => () => {
        unsubscribed = true;
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
    expect(typeof cleanup).toBe("function");
    (cleanup as () => void)();
    expect(unsubscribed).toBe(true);
  });
});
