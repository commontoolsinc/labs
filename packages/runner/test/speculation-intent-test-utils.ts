// Scripted STORAGE-NOTIFICATION harness for the speculation overlay's
// intent listener (server-execution v2 stage C design (e), RULED
// 2026-08-18): a stub `storageManager` that implements exactly the seam
// the overlay consumes — `subscribe` / `unsubscribe` on the notification
// relay, `open(space).replica.getDocument(id, scope)` (the raw read),
// `open(space).sync(...)` (the watch) — and a `deliver` that mutates a
// sidecar doc and dispatches an `IStorageNotification` carrying the
// differential's LEAF-granular change shapes (a mark on entry i is
// `["value","entries","<i>","consequenced"]`; an append is
// `["value","entries"]`; a whole-doc replacement is `[]`). Destination-
// level pins drive THIS seam, never a hand-stubbed `cell.sink` (the old
// pin's seam, retired with the sink). The real differential's shapes are
// covered end to end by `executor-events-down.test.ts` (the full loop)
// and the e2e pins in `speculation-intent-listener.test.ts`.

import type { StreamEventsDocValue } from "@commonfabric/memory/v2";
import type {
  IStorageNotification,
  MemorySpace,
  StorageNotification,
} from "../src/storage/interface.ts";

export type ScriptedIntentManager = {
  /** The stub the overlay is constructed with (`runtime.storageManager`). */
  manager: {
    subscribe(subscription: IStorageNotification): void;
    unsubscribe(subscription: IStorageNotification): void;
    open(space: MemorySpace): {
      replica: {
        getDocument(
          id: string,
          scope?: string,
        ): { value: StreamEventsDocValue } | undefined;
      };
      sync(id: string, selector: unknown, scope?: string): Promise<unknown>;
    };
  };
  /** Live subscribers (the relay's set). */
  readonly subscribers: Set<IStorageNotification>;
  /** `sync` calls seen: `${space}\0${id}\0${scope}`. */
  readonly syncs: string[];
  /** Raw doc reads seen. */
  readonly reads: string[];
  /** Whether a notification dispatch is currently on the stack (a
   * consumer that runs INSIDE `next` sees `true`). */
  readonly dispatching: () => boolean;
  /** Set (or replace) a sidecar doc's value without notifying. */
  seed(space: MemorySpace, id: string, value: StreamEventsDocValue): void;
  /** Mutate the doc and dispatch ONE notification with the given change
   * paths (default: one whole-doc change at `[]`). Returns synchronously
   * — the overlay's check runs in a MICROTASK. */
  deliver(
    space: MemorySpace,
    id: string,
    mutate: (value: StreamEventsDocValue) => void,
    paths?: string[][],
    type?: "commit" | "integrate" | "pull" | "load",
  ): void;
  /** Mutate SEVERAL docs and dispatch ONE notification whose merged
   * changes span them — one frame carrying a wave commit that marks two
   * of this client's sidecars (two streams fired by one client in one
   * wave). Each doc's `paths` default to one whole-doc change at `[]`. */
  deliverMany(
    space: MemorySpace,
    docs: ReadonlyArray<{
      id: string;
      mutate: (value: StreamEventsDocValue) => void;
      paths?: string[][];
    }>,
    type?: "commit" | "integrate" | "pull" | "load",
  ): void;
  /** Dispatch a storage RESET for the space. */
  reset(space: MemorySpace): void;
};

export const scriptedIntentManager = (): ScriptedIntentManager => {
  const subscribers = new Set<IStorageNotification>();
  const docs = new Map<string, { value: StreamEventsDocValue }>();
  const syncs: string[] = [];
  const reads: string[] = [];
  let depth = 0;
  const key = (space: MemorySpace, id: string) => `${space}\0${id}`;
  const dispatch = (notification: StorageNotification) => {
    depth += 1;
    try {
      for (const subscriber of [...subscribers]) {
        try {
          if (subscriber.next(notification)?.done) {
            subscribers.delete(subscriber);
          }
        } catch {
          // the real relay swallows subscriber throws too
        }
      }
    } finally {
      depth -= 1;
    }
  };
  const manager: ScriptedIntentManager["manager"] = {
    subscribe: (subscription) => {
      subscribers.add(subscription);
    },
    unsubscribe: (subscription) => {
      subscribers.delete(subscription);
    },
    open: (space) => ({
      replica: {
        getDocument: (id: string, _scope?: string) => {
          reads.push(key(space, id));
          return docs.get(key(space, id));
        },
      },
      sync: (id: string, _selector: unknown, scope?: string) => {
        syncs.push(`${space}\0${id}\0${scope ?? ""}`);
        return Promise.resolve({ ok: {} });
      },
    }),
  };
  const deliverMany: ScriptedIntentManager["deliverMany"] = (
    space,
    targets,
    type = "integrate",
  ) => {
    const changes: unknown[] = [];
    for (const { id, mutate, paths = [[]] } of targets) {
      const doc = docs.get(key(space, id)) ?? { value: {} };
      const before = doc.value;
      // Mutate a COPY so `before`/`after` differ by identity like the
      // real differential's snapshots do.
      const after: StreamEventsDocValue = {
        ...before,
        entries: [...(before.entries ?? [])].map((entry) => ({ ...entry })),
      };
      mutate(after);
      docs.set(key(space, id), { value: after });
      for (const path of paths) {
        changes.push({
          // The production differential's address shape
          // (`differential.ts` `toAddress`): the normalized scope name
          // rides every change — sidecars are SPACE docs.
          address: {
            id: id as never,
            type: "application/json",
            scope: "space",
            path,
          },
          before: before as never,
          after: after as never,
        });
      }
    }
    dispatch({ type, space, changes } as unknown as StorageNotification);
  };
  return {
    manager,
    subscribers,
    syncs,
    reads,
    dispatching: () => depth > 0,
    seed: (space, id, value) => {
      docs.set(key(space, id), { value });
    },
    deliver: (space, id, mutate, paths = [[]], type = "integrate") => {
      deliverMany(space, [{ id, mutate, paths }], type);
    },
    deliverMany,
    reset: (space) => {
      dispatch({ type: "reset", space });
    },
  };
};

/** Flush the microtask queue (the overlay's checks are microtasks). */
export const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));
