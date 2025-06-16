import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assertSpyCall, assertSpyCalls, spy } from "@std/testing/mock";
import { type ReactivityLog } from "../src/scheduler.ts";
import { Runtime } from "../src/runtime.ts";
import { type Action, type EventHandler } from "../src/scheduler.ts";
import { compactifyPaths } from "../src/scheduler.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("scheduler", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should run actions when cells change", async () => {
    let runCount = 0;
    const a = runtime.getCell<number>(
      space,
      "should run actions when cells change 1",
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should run actions when cells change 2",
    );
    b.set(2);
    const c = runtime.getCell<number>(
      "test",
      "should run actions when cells change 3",
    );
    c.set(0);
    const adder: Action = (log) => {
      runCount++;
      c.withLog(log).send(
        a.getAsQueryResult([], log) + b.getAsQueryResult([], log),
      );
    };
    await runtime.scheduler.run(adder);
    expect(runCount).toBe(1);
    expect(c.get()).toBe(3);
    a.send(2); // No log, simulate external change
    await runtime.idle();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);
  });

  it("schedule shouldn't run immediately", async () => {
    let runCount = 0;
    const a = runtime.getCell<number>(
      "test",
      "should schedule shouldn't run immediately 1",
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should schedule shouldn't run immediately 2",
    );
    b.set(2);
    const c = runtime.getCell<number>(
      "test",
      "should schedule shouldn't run immediately 3",
    );
    c.set(0);
    const adder: Action = (log) => {
      runCount++;
      c.withLog(log).send(
        a.getAsQueryResult([], log) + b.getAsQueryResult([], log),
      );
    };
    runtime.scheduler.schedule(adder, {
      reads: [
        a.getAsCellLink(),
        b.getAsCellLink(),
      ],
      writes: [c.getAsCellLink()],
    });
    expect(runCount).toBe(0);
    expect(c.get()).toBe(0);
    a.send(2); // No log, simulate external change
    await runtime.idle();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
  });

  it("should remove actions", async () => {
    let runCount = 0;
    const a = runtime.getCell<number>("test", "should remove actions 1");
    a.set(1);
    const b = runtime.getCell<number>("test", "should remove actions 2");
    b.set(2);
    const c = runtime.getCell<number>("test", "should remove actions 3");
    c.set(0);
    const adder: Action = (log) => {
      runCount++;
      c.withLog(log).send(
        a.getAsQueryResult([], log) + b.getAsQueryResult([], log),
      );
    };
    await runtime.scheduler.run(adder);
    expect(runCount).toBe(1);
    expect(c.get()).toBe(3);

    a.send(2);
    await runtime.idle();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);

    runtime.scheduler.unschedule(adder);
    a.send(3);
    await runtime.idle();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);
  });

  it("scheduler should return a cancel function", async () => {
    let runCount = 0;
    const a = runtime.getCell<number>(
      "test",
      "scheduler should return a cancel function 1",
    );
    a.set(1);
    const b = runtime.getCell<number>(
      "test",
      "scheduler should return a cancel function 2",
    );
    b.set(2);
    const c = runtime.getCell<number>(
      "test",
      "scheduler should return a cancel function 3",
    );
    c.set(0);
    const adder: Action = (log) => {
      runCount++;
      c.withLog(log).send(
        a.getAsQueryResult([], log) + b.getAsQueryResult([], log),
      );
    };
    const cancel = runtime.scheduler.schedule(adder, {
      reads: [
        a.getAsCellLink(),
        b.getAsCellLink(),
      ],
      writes: [c.getAsCellLink()],
    });
    expect(runCount).toBe(0);
    expect(c.get()).toBe(0);
    a.send(2);
    await runtime.idle();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
    cancel();
    a.send(3);
    await runtime.idle();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
  });

  it("should run actions in topological order", async () => {
    const runs: string[] = [];
    const a = runtime.getCell<number>(
      "test",
      "should run actions in topological order 1",
    );
    a.set(1);
    const b = runtime.getCell<number>(
      "test",
      "should run actions in topological order 2",
    );
    b.set(2);
    const c = runtime.getCell<number>(
      "test",
      "should run actions in topological order 3",
    );
    c.set(0);
    const d = runtime.getCell<number>(
      "test",
      "should run actions in topological order 4",
    );
    d.set(1);
    const e = runtime.getCell<number>(
      "test",
      "should run actions in topological order 5",
    );
    e.set(0);
    const adder1: Action = (log) => {
      runs.push("adder1");
      c.withLog(log).send(
        a.getAsQueryResult([], log) + b.getAsQueryResult([], log),
      );
    };
    const adder2: Action = (log) => {
      runs.push("adder2");
      e.withLog(log).send(
        c.getAsQueryResult([], log) + d.getAsQueryResult([], log),
      );
    };
    await runtime.scheduler.run(adder1);
    await runtime.scheduler.run(adder2);
    expect(runs.join(",")).toBe("adder1,adder2");
    expect(c.get()).toBe(3);
    expect(e.get()).toBe(4);

    d.send(2);
    await runtime.idle();
    expect(runs.join(",")).toBe("adder1,adder2,adder2");
    expect(c.get()).toBe(3);
    expect(e.get()).toBe(5);

    a.send(2);
    await runtime.idle();
    expect(runs.join(",")).toBe("adder1,adder2,adder2,adder1,adder2");
    expect(c.get()).toBe(4);
    expect(e.get()).toBe(6);
  });

  it("should stop eventually when encountering infinite loops", async () => {
    let maxRuns = 120; // More than the limit in scheduler
    const a = runtime.getCell<number>(
      "test",
      "should stop eventually when encountering infinite loops 1",
    );
    a.set(1);
    const b = runtime.getCell<number>(
      "test",
      "should stop eventually when encountering infinite loops 2",
    );
    b.set(2);
    const c = runtime.getCell<number>(
      "test",
      "should stop eventually when encountering infinite loops 3",
    );
    c.set(0);
    const d = runtime.getCell<number>(
      "test",
      "should stop eventually when encountering infinite loops 4",
    );
    d.set(1);
    const e = runtime.getCell<number>(
      "test",
      "should stop eventually when encountering infinite loops 5",
    );
    e.set(0);
    const adder1: Action = (log) => {
      c.withLog(log).send(
        a.getAsQueryResult([], log) + b.getAsQueryResult([], log),
      );
    };
    const adder2: Action = (log) => {
      e.withLog(log).send(
        c.getAsQueryResult([], log) + d.getAsQueryResult([], log),
      );
    };
    const adder3: Action = (log) => {
      if (--maxRuns <= 0) return;
      c.withLog(log).send(
        e.getAsQueryResult([], log) + b.getAsQueryResult([], log),
      );
    };

    const stopper = {
      stop: () => {},
    };
    const stopped = spy(stopper, "stop");
    runtime.scheduler.onError(() => stopper.stop());

    await runtime.scheduler.run(adder1);
    await runtime.scheduler.run(adder2);
    await runtime.scheduler.run(adder3);

    await runtime.idle();

    expect(maxRuns).toBeGreaterThan(10);
    assertSpyCall(stopped, 0, undefined);
  });

  it("should not loop on r/w changes on its own output", async () => {
    const counter = runtime.getCell<number>(
      "test",
      "should not loop on r/w changes on its own output 1",
    );
    counter.set(0);
    const by = runtime.getCell<number>(
      "test",
      "should not loop on r/w changes on its own output 2",
    );
    by.set(1);
    const inc: Action = (log) =>
      counter
        .withLog(log)
        .send(counter.getAsQueryResult([], log) + by.getAsQueryResult([], log));

    const stopper = {
      stop: () => {},
    };
    const stopped = spy(stopper, "stop");
    runtime.scheduler.onError(() => stopper.stop());

    await runtime.scheduler.run(inc);
    expect(counter.get()).toBe(1);
    await runtime.idle();
    expect(counter.get()).toBe(1);

    by.send(2);
    await runtime.idle();
    expect(counter.get()).toBe(3);

    assertSpyCalls(stopped, 0);
  });

  it("should immediately run actions that have no dependencies", async () => {
    let runs = 0;
    const inc: Action = () => runs++;
    runtime.scheduler.schedule(inc, { reads: [], writes: [] });
    await runtime.idle();
    expect(runs).toBe(1);
  });
});

describe("event handling", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should queue and process events", async () => {
    const eventCell = runtime.getCell<number>(
      "test",
      "should queue and process events 1",
    );
    eventCell.set(0);
    const eventResultCell = runtime.getCell<number>(
      "test",
      "should queue and process events 2",
    );
    eventResultCell.set(0);
    let eventCount = 0;

    const eventHandler: EventHandler = (event) => {
      eventCount++;
      eventResultCell.send(event);
    };

    runtime.scheduler.addEventHandler(eventHandler, eventCell.getAsCellLink());

    runtime.scheduler.queueEvent(eventCell.getAsCellLink(), 1);
    runtime.scheduler.queueEvent(eventCell.getAsCellLink(), 2);

    await runtime.idle();

    expect(eventCount).toBe(2);
    expect(eventCell.get()).toBe(0); // Events are _not_ written to cell
    expect(eventResultCell.get()).toBe(2);
  });

  it("should remove event handlers", async () => {
    const eventCell = runtime.getCell<number>(
      "test",
      "should remove event handlers 1",
    );
    eventCell.set(0);
    let eventCount = 0;

    const eventHandler: EventHandler = (event) => {
      eventCount++;
      eventCell.send(event);
    };

    const removeHandler = runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsCellLink(),
    );

    runtime.scheduler.queueEvent(eventCell.getAsCellLink(), 1);
    await runtime.idle();

    expect(eventCount).toBe(1);
    expect(eventCell.get()).toBe(1);

    removeHandler();

    runtime.scheduler.queueEvent(eventCell.getAsCellLink(), 2);
    await runtime.idle();

    expect(eventCount).toBe(1);
    expect(eventCell.get()).toBe(1);
  });

  it("should handle events with nested paths", async () => {
    const parentCell = runtime.getCell<{ child: { value: number } }>(
      "test",
      "should handle events with nested paths 1",
    );
    parentCell.set({ child: { value: 0 } });
    let eventCount = 0;

    const eventHandler: EventHandler = () => {
      eventCount++;
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      parentCell.key("child").key("value").getAsCellLink(),
    );

    runtime.scheduler.queueEvent(
      parentCell.key("child").key("value").getAsCellLink(),
      42,
    );
    await runtime.idle();

    expect(eventCount).toBe(1);
  });

  it("should process events in order", async () => {
    const eventCell = runtime.getCell<number>(
      "test",
      "should process events in order 1",
    );
    eventCell.set(0);
    const events: number[] = [];

    const eventHandler: EventHandler = (event) => {
      events.push(event);
    };

    runtime.scheduler.addEventHandler(eventHandler, eventCell.getAsCellLink());

    runtime.scheduler.queueEvent(eventCell.getAsCellLink(), 1);
    runtime.scheduler.queueEvent(eventCell.getAsCellLink(), 2);
    runtime.scheduler.queueEvent(eventCell.getAsCellLink(), 3);

    await runtime.idle();

    expect(events).toEqual([1, 2, 3]);
  });

  it("should trigger recomputation of dependent cells", async () => {
    const eventCell = runtime.getCell<number>(
      "test",
      "should trigger recomputation of dependent cells 1",
    );
    eventCell.set(0);
    const eventResultCell = runtime.getCell<number>(
      "test",
      "should trigger recomputation of dependent cells 2",
    );
    eventResultCell.set(0);
    let eventCount = 0;
    let actionCount = 0;
    let lastEventSeen = 0;

    const eventHandler: EventHandler = (event) => {
      eventCount++;
      eventResultCell.send(event);
    };

    const action = (log: ReactivityLog) => {
      actionCount++;
      lastEventSeen = eventResultCell.getAsQueryResult([], log);
    };
    await runtime.scheduler.run(action);

    runtime.scheduler.addEventHandler(eventHandler, eventCell.getAsCellLink());

    expect(actionCount).toBe(1);

    runtime.scheduler.queueEvent(eventCell.getAsCellLink(), 1);
    await runtime.idle();

    expect(eventCount).toBe(1);
    expect(eventResultCell.get()).toBe(1);

    expect(actionCount).toBe(2);

    runtime.scheduler.queueEvent(eventCell.getAsCellLink(), 2);
    await runtime.idle();

    expect(eventCount).toBe(2);
    expect(eventResultCell.get()).toBe(2);
    expect(actionCount).toBe(3);
    expect(lastEventSeen).toBe(2);
  });
});

describe("compactifyPaths", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  // helper to normalize CellLinks because compactifyPaths() does not preserve
  // the extra properties added by cell.getAsCellLink()
  const normalizeCellLink = (link: any) => ({
    cell: link.cell,
    path: link.path,
  });

  it("should compactify paths", () => {
    const testCell = runtime.getCell<Record<string, any>>(
      "test",
      "should compactify paths 1",
    );
    testCell.set({});
    const paths = [
      testCell.key("a").key("b").getAsCellLink(),
      testCell.key("a").getAsCellLink(),
      testCell.key("c").getAsCellLink(),
    ];
    const result = compactifyPaths(paths);
    const expected = [
      testCell.key("a").getAsCellLink(),
      testCell.key("c").getAsCellLink(),
    ];
    expect(result.map(normalizeCellLink)).toEqual(
      expected.map(normalizeCellLink),
    );
  });

  it("should remove duplicate paths", () => {
    const testCell = runtime.getCell<Record<string, any>>(
      "test",
      "should remove duplicate paths 1",
    );
    testCell.set({});
    const paths = [
      testCell.key("a").key("b").getAsCellLink(),
      testCell.key("a").key("b").getAsCellLink(),
    ];
    const result = compactifyPaths(paths);
    const expected = [testCell.key("a").key("b").getAsCellLink()];
    expect(result.map(normalizeCellLink)).toEqual(
      expected.map(normalizeCellLink),
    );
  });

  it("should not compactify across cells", () => {
    const cellA = runtime.getCell<Record<string, any>>(
      "test",
      "should not compactify across cells 1",
    );
    cellA.set({});
    const cellB = runtime.getCell<Record<string, any>>(
      "test",
      "should not compactify across cells 2",
    );
    cellB.set({});
    const paths = [
      cellA.key("a").key("b").getAsCellLink(),
      cellB.key("a").key("b").getAsCellLink(),
    ];
    const result = compactifyPaths(paths);
    expect(result.map(normalizeCellLink)).toEqual(paths.map(normalizeCellLink));
  });

  it("empty paths should trump all other ones", () => {
    const cellA = runtime.getCell<Record<string, any>>(
      "test",
      "should remove duplicate paths 1",
    );
    cellA.set({});

    const expectedResult = cellA.getAsCellLink();
    const paths = [
      cellA.key("a").key("b").getAsCellLink(),
      cellA.key("c").getAsCellLink(),
      cellA.key("d").getAsCellLink(),
      expectedResult,
    ];
    const result = compactifyPaths(paths);

    expect(result.map(normalizeCellLink)).toEqual(
      [expectedResult].map(normalizeCellLink),
    );
  });
});
