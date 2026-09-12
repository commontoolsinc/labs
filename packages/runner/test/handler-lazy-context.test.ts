import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import type { EventHandler } from "../src/scheduler.ts";
import type { IStorageNotification } from "../src/storage/interface.ts";
import type { RuntimeTelemetryEvent } from "../src/telemetry.ts";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  type SchedulerTestRuntime,
  space,
} from "./scheduler-test-utils.ts";

type Item = { label: string; note?: number };

/**
 * One pattern with the handlers the cases dispatch to. `plain` handlers bind
 * the list as a value, so its rows are the handler's bound context; `handle`
 * handlers bind it as a cell and read through the handle.
 */
const PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "type Item = { label: string; note?: number };",
  "type Plain = { items: Item[]; out: Writable<number> };",
  "type Handle = { items: Writable<Item[]>; out: Writable<number> };",
  "const first = handler<unknown, Plain>((_ev, { items, out }) => {",
  "  out.set(items[0].label.length);",
  "});",
  "const firstViaHandle = handler<unknown, Handle>((_ev, { items, out }) => {",
  "  out.set(items.get()[0].label.length);",
  "});",
  // Writes, then touches the second row's required label.
  "const second = handler<unknown, Plain>((_ev, { items, out }) => {",
  "  out.set(1);",
  "  out.set(items[1].label.length);",
  "});",
  // Catches the refusal and writes anyway.
  "const secondCaught = handler<unknown, Plain>((_ev, { items, out }) => {",
  "  let length = -1;",
  "  try {",
  "    length = items[1].label.length;",
  "  } catch {",
  "    length = -1;",
  "  }",
  "  out.set(length);",
  "});",
  "const secondAsync = handler<unknown, Plain>(async (_ev, { items, out }) => {",
  "  await Promise.resolve();",
  "  out.set(items[1].label.length);",
  "});",
  "const note = handler<unknown, Plain>((_ev, { items, out }) => {",
  "  out.set(items[0].note === undefined ? -1 : items[0].note);",
  "});",
  "const echo = handler<{ count: number }, Plain>((event, { out }) => {",
  "  out.set(event === undefined ? -1 : event.count);",
  "});",
  "const firstAsResult = handler<unknown, Plain, { first: string }>(",
  "  (_ev, { items }) => ({ first: items[0].label }),",
  ");",
  "export default pattern<",
  "  { items: Writable<Item[]>; out: Writable<number> },",
  "  {",
  "    out: number;",
  "    first: Stream<unknown>;",
  "    firstViaHandle: Stream<unknown>;",
  "    second: Stream<unknown>;",
  "    secondCaught: Stream<unknown>;",
  "    secondAsync: Stream<unknown>;",
  "    note: Stream<unknown>;",
  "    echo: Stream<{ count: number }>;",
  "    firstAsResult: Stream<unknown, { first: string }>;",
  "  }",
  ">(({ items, out }) => ({",
  "  out,",
  "  first: first({ items, out }),",
  "  firstViaHandle: firstViaHandle({ items, out }),",
  "  second: second({ items, out }),",
  "  secondCaught: secondCaught({ items, out }),",
  "  secondAsync: secondAsync({ items, out }),",
  "  note: note({ items, out }),",
  "  echo: echo({ items, out }),",
  "  firstAsResult: firstAsResult({ items, out }),",
  "}));",
].join("\n");

/** The item list's schema, which makes an unmarked read of it eager. */
const ITEMS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: { label: { type: "string" }, note: { type: "number" } },
    required: ["label"],
  },
} as const;

type Sender = {
  send(
    value: unknown,
    onCommit: (tx: {
      status(): { status: string };
      handlingReceiptLink?: unknown;
    }) => void,
  ): void;
};

describe("handler lazy context", () => {
  // Every case dispatches a real event to a compiled handler and observes the
  // outcome from outside: what committed, what the callback saw, how many
  // links the handler's own attempt resolved. Nothing here marks a
  // transaction by hand.

  let env: SchedulerTestRuntime | undefined;

  afterEach(async () => {
    if (env !== undefined) await disposeSchedulerTestRuntime(env);
    env = undefined;
  });

  /** A runtime in the given posture with the pattern running over `items`. */
  async function start(lazyMaterialization: boolean, items: Item[]) {
    env = createSchedulerTestRuntime(import.meta.url, {
      experimental: { lazyMaterialization },
    });
    const { runtime, tx } = env;
    runtime.scheduler.setReadStatsEnabled(true, { attempts: true });
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: PATTERN }],
    }, { space, tx });
    const itemsCell = runtime.getCell<Item[]>(space, "items", undefined, tx);
    itemsCell.set(items);
    const out = runtime.getCell<number>(space, "out", undefined, tx);
    out.set(0);
    const argument = runtime.getCell<{ items: unknown; out: unknown }>(
      space,
      "argument",
      undefined,
      tx,
    );
    argument.set({ items: itemsCell, out });
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "result",
      compiled.resultSchema,
      tx,
    );
    runtime.run(tx, compiled, argument, result);
    await tx.commit();
    env.tx = runtime.edit();
    await runtime.idle();

    let commits = 0;
    const subscription: IStorageNotification = {
      next(notification) {
        if (notification.type === "commit") {
          for (const _change of notification.changes) {
            commits++;
            break;
          }
        }
        return { done: false };
      },
    };
    runtime.storageManager.subscribe(subscription);

    const eventLinkResolutions: number[] = [];
    let dispatches = 0;
    const settledAfterDispatch = () => {
      const settled = Promise.withResolvers<void>();
      const before = dispatches;
      const onTelemetry = (event: Event) => {
        const { marker } = (event as RuntimeTelemetryEvent).detail;
        if (marker.type === "scheduler.settle" && dispatches > before) {
          runtime.telemetry.removeEventListener("telemetry", onTelemetry);
          settled.resolve();
        }
      };
      runtime.telemetry.addEventListener("telemetry", onTelemetry);
      return settled.promise;
    };
    runtime.telemetry.addEventListener("telemetry", (event: Event) => {
      const { marker } = (event as RuntimeTelemetryEvent).detail;
      if (marker.type === "scheduler.invocation") dispatches++;
      if (marker.type === "scheduler.read-attempt" && marker.kind === "event") {
        eventLinkResolutions.push(marker.reads.linkResolutions);
      }
    });

    const send = (stream: string, payload: unknown = {}) => {
      const statuses: string[] = [];
      const receipts: unknown[] = [];
      (result.key(stream) as unknown as Sender).send(payload, (commitTx) => {
        statuses.push(commitTx.status().status);
        receipts.push(commitTx.handlingReceiptLink);
      });
      return { statuses, receipts };
    };
    const settle = async () => {
      await runtime.idle();
      await runtime.scheduler.idleWithPendingCommits();
    };
    const fixSecondLabel = async () => {
      const write = runtime.edit();
      itemsCell.key(1).key("label").withTx(write).set("bb");
      expect((await write.commit()).error).toBeUndefined();
    };

    return {
      runtime,
      out,
      send,
      settle,
      settledAfterDispatch,
      fixSecondLabel,
      commits: () => commits,
      dispatches: () => dispatches,
      eventLinkResolutions,
    };
  }

  const ROWS = 40;
  const rows = (): Item[] =>
    Array.from({ length: ROWS }, (_, index) => ({ label: `row${index}` }));

  /** Rows whose second entry lacks the label the item schema requires. */
  const rowsWithBrokenSecond = (): Item[] => {
    const all = rows();
    all[1] = { note: 2 } as unknown as Item;
    return all;
  };

  describe("reads", () => {
    it("resolves fewer links for a one-element read of a plain context than the eager read does", async () => {
      const eager = await start(false, rows());
      eager.send("first");
      await eager.settle();
      expect(eager.out.get()).toBe(4);
      const eagerLinks = eager.eventLinkResolutions.at(-1)!;
      await disposeSchedulerTestRuntime(env!);
      env = undefined;

      const lazy = await start(true, rows());
      lazy.send("first");
      await lazy.settle();
      expect(lazy.out.get()).toBe(4);
      const lazyLinks = lazy.eventLinkResolutions.at(-1)!;

      expect(eagerLinks).toBeGreaterThanOrEqual(ROWS);
      expect(lazyLinks).toBeLessThan(ROWS / 2);
    });

    it("reads through a bound handle lazily, since the handle inherits the mark", async () => {
      const eager = await start(false, rows());
      eager.send("firstViaHandle");
      await eager.settle();
      expect(eager.out.get()).toBe(4);
      const eagerLinks = eager.eventLinkResolutions.at(-1)!;
      await disposeSchedulerTestRuntime(env!);
      env = undefined;

      const lazy = await start(true, rows());
      lazy.send("firstViaHandle");
      await lazy.settle();
      expect(lazy.out.get()).toBe(4);
      const lazyLinks = lazy.eventLinkResolutions.at(-1)!;

      expect(eagerLinks).toBeGreaterThanOrEqual(ROWS);
      expect(lazyLinks).toBeLessThan(ROWS / 2);
    });

    it("runs when the mismatch is in a row the body never touches", async () => {
      const lazy = await start(true, rowsWithBrokenSecond());
      const { statuses } = lazy.send("first");
      await lazy.settle();
      expect(lazy.out.get()).toBe(4);
      expect(statuses).toEqual(["done"]);
    });

    it("reads an absent optional field as `undefined` and runs", async () => {
      const lazy = await start(true, rows());
      const { statuses } = lazy.send("note");
      await lazy.settle();
      expect(lazy.out.get()).toBe(-1);
      expect(statuses).toEqual(["done"]);
    });

    it("delivers the event payload the same way in both postures", async () => {
      const eager = await start(false, rows());
      eager.send("echo", { count: 3 });
      await eager.settle();
      const eagerCount = eager.out.get();
      await disposeSchedulerTestRuntime(env!);
      env = undefined;

      const lazy = await start(true, rows());
      lazy.send("echo", { count: 3 });
      await lazy.settle();
      expect(lazy.out.get()).toBe(eagerCount);
      expect(eagerCount).toBe(3);
    });

    it("returns a value read through the view as a plain result", async () => {
      const lazy = await start(true, rows());
      const { statuses, receipts } = lazy.send("firstAsResult");
      await lazy.settle();
      expect(statuses).toEqual(["done"]);
      expect(receipts).toHaveLength(1);
      const receipt = lazy.runtime.getCellFromLink(receipts[0] as never);
      expect(receipt.get()).toEqual({ first: "row0" });
    });
  });

  describe("refusal", () => {
    // A refusal is a handler that did not run: the transaction is withdrawn,
    // so what the body wrote before it never commits, and the dispatch is
    // re-run until the data matches. The commit callback fires once, on the
    // run that committed.

    it("withdraws a run that touched a required field the data does not carry, and re-runs once it does", async () => {
      const lazy = await start(true, rowsWithBrokenSecond());
      const { statuses, receipts } = lazy.send("second");
      await lazy.settledAfterDispatch();
      expect(lazy.dispatches()).toBeGreaterThanOrEqual(1);
      expect(statuses).toEqual([]);
      expect(lazy.commits()).toBe(0);
      expect(lazy.out.get()).toBe(0);

      await lazy.fixSecondLabel();
      await lazy.settle();
      expect(lazy.out.get()).toBe(2);
      expect(statuses).toEqual(["done"]);
      expect(receipts[0]).toBeDefined();
      expect(lazy.commits()).toBe(2);
    });

    it("disposes of a refusal the body caught the same way", async () => {
      const lazy = await start(true, rowsWithBrokenSecond());
      const { statuses } = lazy.send("secondCaught");
      await lazy.settledAfterDispatch();
      expect(statuses).toEqual([]);
      expect(lazy.out.get()).toBe(0);

      await lazy.fixSecondLabel();
      await lazy.settle();
      expect(lazy.out.get()).toBe(2);
      expect(statuses).toEqual(["done"]);
    });

    it("disposes of a refusal an async body reached after an `await` the same way", async () => {
      const lazy = await start(true, rowsWithBrokenSecond());
      const { statuses } = lazy.send("secondAsync");
      await lazy.settledAfterDispatch();
      expect(statuses).toEqual([]);
      expect(lazy.out.get()).toBe(0);

      await lazy.fixSecondLabel();
      await lazy.settle();
      expect(lazy.out.get()).toBe(2);
      expect(statuses).toEqual(["done"]);
    });

    it("skips the run eagerly for the same data when the flag is off", async () => {
      const eager = await start(false, rowsWithBrokenSecond());
      const { statuses } = eager.send("first");
      await eager.settledAfterDispatch();
      expect(statuses).toEqual([]);
      expect(eager.out.get()).toBe(0);

      await eager.fixSecondLabel();
      await eager.settle();
      expect(eager.out.get()).toBe(4);
      expect(statuses).toEqual(["done"]);
    });
  });

  describe("commit preconditions", () => {
    // A handler's read log is what its commit's preconditions are built from,
    // so the read set is also the concurrency contract: a concurrent write to
    // a path the log covers makes the commit retry. An eager read of a list
    // covers every row; a view covers the rows the body touched. The handler
    // here is registered on the scheduler directly, reads under the mark the
    // runner would set, and holds its transaction open across a barrier while
    // a second runtime on the same store writes a row it never touched.

    /** What the second runtime writes while the handler holds its barrier. */
    type ConcurrentWrite =
      | "untouched-row-field"
      | "touched-row-field"
      | "append";

    /**
     * Dispatches one event to a handler that reads the first row under the
     * given posture, then waits at `gate` while the second runtime performs
     * `write`; returns how many times the handler ran once everything
     * settled, and the callback statuses.
     */
    async function runAgainstConcurrentWrite(
      lazy: boolean,
      write: ConcurrentWrite = "untouched-row-field",
    ): Promise<{ runs: number; statuses: string[] }> {
      env = createSchedulerTestRuntime(import.meta.url);
      const { runtime, tx, storageManager } = env;
      const sibling = createSchedulerTestRuntime(import.meta.url, {
        storageManager,
      });
      try {
        const items = runtime.getCell<Item[]>(
          space,
          "shared-items",
          undefined,
          tx,
        );
        items.set(rows());
        const out = runtime.getCell<number>(space, "shared-out", undefined, tx);
        const eventCell = runtime.getCell<number>(
          space,
          "shared-events",
          undefined,
          tx,
        );
        await tx.commit();
        env.tx = runtime.edit();
        await sibling.tx.commit();
        sibling.tx = sibling.runtime.edit();
        await runtime.idle();
        await sibling.runtime.idle();

        let runs = 0;
        const entered = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        const handler: EventHandler = async (actionTx) => {
          runs++;
          if (lazy) actionTx.markLazyMaterialize(true);
          const length = items
            .asSchema(ITEMS_SCHEMA)
            .withTx(actionTx)
            .get()[0].label.length;
          actionTx.markLazyMaterialize(false);
          entered.resolve();
          await gate.promise;
          out.withTx(actionTx).send(length);
        };
        runtime.scheduler.addEventHandler(
          handler,
          eventCell.getAsNormalizedFullLink(),
        );
        const statuses: string[] = [];
        runtime.scheduler.queueEvent(
          eventCell.getAsNormalizedFullLink(),
          1,
          true,
          (commitTx) => {
            statuses.push(commitTx.status().status);
          },
        );
        await entered.promise;

        // The write the handler's commit may or may not conflict with.
        const siblingItems = sibling.runtime.getCell<Item[]>(
          space,
          "shared-items",
          undefined,
        );
        const edit = sibling.runtime.edit();
        switch (write) {
          case "untouched-row-field":
            siblingItems.key(1).key("label").withTx(edit).set("changed");
            break;
          case "touched-row-field":
            siblingItems.key(0).key("label").withTx(edit).set("row0-changed");
            break;
          case "append":
            siblingItems.withTx(edit).push({ label: "appended" });
            break;
        }
        expect((await edit.commit()).error).toBeUndefined();
        await sibling.runtime.idle();
        await sibling.runtime.scheduler.idleWithPendingCommits();

        gate.resolve();
        await runtime.idle();
        await runtime.scheduler.idleWithPendingCommits();
        expect(out.get()).toBe(write === "touched-row-field" ? 12 : 4);
        return { runs, statuses };
      } finally {
        await sibling.runtime.dispose({ closeStorage: false });
      }
    }

    it("retries an eager handler's commit when an untouched row changed underneath it", async () => {
      const outcome = await runAgainstConcurrentWrite(false);
      expect(outcome.statuses).toEqual(["done"]);
      expect(outcome.runs).toBeGreaterThan(1);
    });

    it("commits a lazy handler's run once, since the untouched row is outside its read set", async () => {
      const outcome = await runAgainstConcurrentWrite(true);
      expect(outcome.statuses).toEqual(["done"]);
      expect(outcome.runs).toBe(1);
    });

    it("retries a lazy handler's commit when the row it touched changed underneath it", async () => {
      const outcome = await runAgainstConcurrentWrite(
        true,
        "touched-row-field",
      );
      expect(outcome.statuses).toEqual(["done"]);
      expect(outcome.runs).toBeGreaterThan(1);
    });

    it("retries a lazy handler's commit when a row was appended underneath it", async () => {
      // An append changes the list's own document, which the view read to
      // reach row 0, so the list is in the read set either way.
      const outcome = await runAgainstConcurrentWrite(true, "append");
      expect(outcome.statuses).toEqual(["done"]);
      expect(outcome.runs).toBeGreaterThan(1);
    });

    it("retries an eager handler's commit when a row was appended underneath it", async () => {
      const outcome = await runAgainstConcurrentWrite(false, "append");
      expect(outcome.statuses).toEqual(["done"]);
      expect(outcome.runs).toBeGreaterThan(1);
    });
  });
});
