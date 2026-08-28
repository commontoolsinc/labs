// @deno-types="@types/react"
import React, { act } from "react";
// @deno-types="@types/react-dom/client"
import { createRoot } from "react-dom/client";
import { assertEquals, assertInstanceOf } from "@std/assert";

import type { FabricClient, ResourceSnapshot } from "../src/guest.ts";
import { createFabricReact } from "../src/react.ts";

type Counter = { count: number };
type Note = { id: number; title: string };

function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
  });
}

function perform(action: () => void): Promise<void> {
  return act(async () => {
    action();
    await Promise.resolve();
  });
}

Deno.test("React renders bridged cells and SQLite invalidations", async () => {
  if (typeof document === "undefined") return;
  const environment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;

  let counterSnapshot: ResourceSnapshot<Counter> = { status: "loading" };
  const cellListeners = new Set<() => void>();
  let writeTail = Promise.resolve();
  const publishCounter = (count: number) => {
    counterSnapshot = { status: "ready", value: { count } };
    for (const listener of cellListeners) listener();
  };
  const counter = {
    getSnapshot: () => counterSnapshot,
    subscribeSnapshot: (listener: () => void) => {
      cellListeners.add(listener);
      listener();
      return () => cellListeners.delete(listener);
    },
    pull: () => {
      publishCounter(1);
      return Promise.resolve({ count: 1 });
    },
    set: (value: Counter) => {
      publishCounter(value.count);
      return Promise.resolve();
    },
    update: (updater: (current: Counter) => Counter) => {
      const write = writeTail.then(async () => {
        const current = counterSnapshot.status === "ready"
          ? counterSnapshot.value
          : await counter.pull();
        await counter.set(updater(current));
      });
      writeTail = write.catch(() => {});
      return write;
    },
  };

  let notes: Note[] = [{ id: 1, title: "First" }];
  let queryCount = 0;
  const databaseListeners = new Set<() => void>();
  const database = {
    query: () => {
      queryCount++;
      return Promise.resolve({ rows: notes.map((note) => ({ ...note })) });
    },
    sink: (listener: () => void) => {
      databaseListeners.add(listener);
      return () => databaseListeners.delete(listener);
    },
  };
  const client = {
    cell: () => counter,
    sqlite: () => database,
  } as unknown as FabricClient;
  const { useCell, useSqliteQuery } = createFabricReact(React, client);

  function App() {
    const count = useCell<Counter>("counter");
    const query = useSqliteQuery<Note>(
      "appDatabase",
      "SELECT id, title FROM notes ORDER BY id",
    );
    if (count.status !== "ready" || query.status !== "ready") {
      return React.createElement("p", { id: "status" }, "Loading");
    }
    return React.createElement(
      "main",
      null,
      React.createElement(
        "button",
        {
          id: "increment",
          type: "button",
          onClick: () =>
            void count.set((value) => ({
              count: value.count + 1,
            })),
        },
        `Count ${count.value.count}`,
      ),
      React.createElement(
        "p",
        { id: "notes" },
        query.rows.map((note) => note.title).join(", "),
      ),
    );
  }

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await perform(() => root.render(React.createElement(App)));
    await flush();

    const button = host.querySelector("#increment");
    assertInstanceOf(button, HTMLButtonElement);
    assertEquals(button.textContent?.trim(), "Count 1");
    assertEquals(host.querySelector("#notes")?.textContent, "First");

    await perform(() => button.click());
    await flush();
    assertEquals(button.textContent?.trim(), "Count 2");

    notes = [...notes, { id: 2, title: "Second" }];
    await perform(() => {
      for (const listener of databaseListeners) listener();
    });
    await flush();
    assertEquals(host.querySelector("#notes")?.textContent, "First, Second");
    assertEquals(queryCount >= 2, true);
  } finally {
    await perform(() => root.unmount());
    host.remove();
    environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
