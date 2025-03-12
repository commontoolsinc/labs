import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assertSpyCall, assertSpyCalls, spy } from "@std/testing/mock";
import { getDoc } from "../src/doc.ts";
import { type ReactivityLog } from "../src/scheduler.ts";
import {
  type Action,
  addEventHandler,
  compactifyPaths,
  type EventHandler,
  idle,
  onError,
  queueEvent,
  run,
  schedule,
  unschedule,
} from "../src/scheduler.ts";

describe("scheduler", () => {
  it("should run actions when cells change", async () => {
    let runCount = 0;
    const a = getDoc(
      1,
      "should run actions when cells change 1",
      "test",
    );
    const b = getDoc(
      2,
      "should run actions when cells change 2",
      "test",
    );
    const c = getDoc(
      0,
      "should run actions when cells change 3",
      "test",
    );
    const adder: Action = (log) => {
      runCount++;
      c.asCell([], log).send(
        a.getAsQueryResult([], log) + b.getAsQueryResult([], log),
      );
    };
    await run(adder);
    expect(runCount).toBe(1);
    expect(c.get()).toBe(3);
    a.send(2); // No log, simulate external change
    await idle();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);
  });

  it("schedule shouldn't run immediately", async () => {
    let runCount = 0;
    const a = getDoc(
      1,
      "should schedule shouldn't run immediately 1",
      "test",
    );
    const b = getDoc(
      2,
      "should schedule shouldn't run immediately 2",
      "test",
    );
    const c = getDoc(
      0,
      "should schedule shouldn't run immediately 3",
      "test",
    );
    const adder: Action = (log) => {
      runCount++;
      c.asCell([], log).send(
        a.getAsQueryResult([], log) + b.getAsQueryResult([], log),
      );
    };
    schedule(adder, {
      reads: [
        { cell: a, path: [] },
        { cell: b, path: [] },
      ],
      writes: [{ cell: c, path: [] }],
    });
    expect(runCount).toBe(0);
    expect(c.get()).toBe(0);
    a.send(2); // No log, simulate external change
    await idle();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
  });

  it("should remove actions", async () => {
    let runCount = 0;
    const a = getDoc(1, "should remove actions 1", "test");
    const b = getDoc(2, "should remove actions 2", "test");
    const c = getDoc(0, "should remove actions 3", "test");
    const adder: Action = (log) => {
      runCount++;
      c.asCell([], log).send(
        a.getAsQueryResult([], log) + b.getAsQueryResult([], log),
      );
    };
    await run(adder);
    expect(runCount).toBe(1);
    expect(c.get()).toBe(3);

    a.send(2);
    await idle();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);

    unschedule(adder);
    a.send(3);
    await idle();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);
  });

  it("scheduler should return a cancel function", async () => {
    let runCount = 0;
    const a = getDoc(
      1,
      "scheduler should return a cancel function 1",
      "test",
    );
    const b = getDoc(
      2,
      "scheduler should return a cancel function 2",
      "test",
    );
    const c = getDoc(
      0,
      "scheduler should return a cancel function 3",
      "test",
    );
    const adder: Action = (log) => {
      runCount++;
      c.asCell([], log).send(
        a.getAsQueryResult([], log) + b.getAsQueryResult([], log),
      );
    };
    const cancel = schedule(adder, {
      reads: [
        { cell: a, path: [] },
        { cell: b, path: [] },
      ],
      writes: [{ cell: c, path: [] }],
    });
    expect(runCount).toBe(0);
    expect(c.get()).toBe(0);
    a.send(2);
    await idle();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
    cancel();
    a.send(3);
    await idle();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
  });

  it("should run actions in topological order", async () => {
    const runs: string[] = [];
    const a = getDoc(
      1,
      "should run actions in topological order 1",
      "test",
    );
    const b = getDoc(
      2,
      "should run actions in topological order 2",
      "test",
    );
    const c = getDoc(
      0,
      "should run actions in topological order 3",
      "test",
    );
    const d = getDoc(
      1,
      "should run actions in topological order 4",
      "test",
    );
    const e = getDoc(
      0,
      "should run actions in topological order 5",
      "test",
    );
    const adder1: Action = (log) => {
      runs.push("adder1");
      c.asCell([], log).send(
        a.getAsQueryResult([], log) + b.getAsQueryResult([], log),
      );
    };
    const adder2: Action = (log) => {
      runs.push("adder2");
      e.asCell([], log).send(
        c.getAsQueryResult([], log) + d.getAsQueryResult([], log),
      );
    };
    await run(adder1);
    await run(adder2);
    expect(runs.join(",")).toBe("adder1,adder2");
    expect(c.get()).toBe(3);
    expect(e.get()).toBe(4);

    d.send(2);
    await idle();
    expect(runs.join(",")).toBe("adder1,adder2,adder2");
    expect(c.get()).toBe(3);
    expect(e.get()).toBe(5);

    a.send(2);
    await idle();
    expect(runs.join(",")).toBe("adder1,adder2,adder2,adder1,adder2");
    expect(c.get()).toBe(4);
    expect(e.get()).toBe(6);
  });

  it("should stop eventually when encountering infinite loops", async () => {
    let maxRuns = 120; // More than the limit in scheduler
    const a = getDoc(
      1,
      "should stop eventually when encountering infinite loops 1",
      "test",
    );
    const b = getDoc(
      2,
      "should stop eventually when encountering infinite loops 2",
      "test",
    );
    const c = getDoc(
      0,
      "should stop eventually when encountering infinite loops 3",
      "test",
    );
    const d = getDoc(
      1,
      "should stop eventually when encountering infinite loops 4",
      "test",
    );
    const e = getDoc(
      0,
      "should stop eventually when encountering infinite loops 5",
      "test",
    );
    const adder1: Action = (log) => {
      c.asCell([], log).send(
        a.getAsQueryResult([], log) + b.getAsQueryResult([], log),
      );
    };
    const adder2: Action = (log) => {
      e.asCell([], log).send(
        c.getAsQueryResult([], log) + d.getAsQueryResult([], log),
      );
    };
    const adder3: Action = (log) => {
      if (--maxRuns <= 0) return;
      c.asCell([], log).send(
        e.getAsQueryResult([], log) + b.getAsQueryResult([], log),
      );
    };

    const stopper = {
      stop: () => {},
    };
    const stopped = spy(stopper, "stop");
    onError(() => stopper.stop());

    await run(adder1);
    await run(adder2);
    await run(adder3);

    await idle();

    expect(maxRuns).toBeGreaterThan(10);
    assertSpyCall(stopped, 0, undefined);
  });

  it("should not loop on r/w changes on its own output", async () => {
    const counter = getDoc(
      0,
      "should not loop on r/w changes on its own output 1",
      "test",
    );
    const by = getDoc(
      1,
      "should not loop on r/w changes on its own output 2",
      "test",
    );
    const inc: Action = (log) =>
      counter
        .asCell([], log)
        .send(counter.getAsQueryResult([], log) + by.getAsQueryResult([], log));

    const stopper = {
      stop: () => {},
    };
    const stopped = spy(stopper, "stop");
    onError(() => stopper.stop());

    await run(inc);
    expect(counter.get()).toBe(1);
    await idle();
    expect(counter.get()).toBe(1);

    by.send(2);
    await idle();
    expect(counter.get()).toBe(3);

    assertSpyCalls(stopped, 0);
  });

  it("should immediately run actions that have no dependencies", async () => {
    let runs = 0;
    const inc: Action = () => runs++;
    schedule(inc, { reads: [], writes: [] });
    await idle();
    expect(runs).toBe(1);
  });
});

describe("event handling", () => {
  it("should queue and process events", async () => {
    const eventCell = getDoc(
      0,
      "should queue and process events 1",
      "test",
    );
    const eventResultCell = getDoc(
      0,
      "should queue and process events 2",
      "test",
    );
    let eventCount = 0;

    const eventHandler: EventHandler = (event) => {
      eventCount++;
      eventResultCell.send(event);
    };

    addEventHandler(eventHandler, { cell: eventCell, path: [] });

    queueEvent({ cell: eventCell, path: [] }, 1);
    queueEvent({ cell: eventCell, path: [] }, 2);

    await idle();

    expect(eventCount).toBe(2);
    expect(eventCell.get()).toBe(0); // Events are _not_ written to cell
    expect(eventResultCell.get()).toBe(2);
  });

  it("should remove event handlers", async () => {
    const eventCell = getDoc(
      0,
      "should remove event handlers 1",
      "test",
    );
    let eventCount = 0;

    const eventHandler: EventHandler = (event) => {
      eventCount++;
      eventCell.send(event);
    };

    const removeHandler = addEventHandler(eventHandler, {
      cell: eventCell,
      path: [],
    });

    queueEvent({ cell: eventCell, path: [] }, 1);
    await idle();

    expect(eventCount).toBe(1);
    expect(eventCell.get()).toBe(1);

    removeHandler();

    queueEvent({ cell: eventCell, path: [] }, 2);
    await idle();

    expect(eventCount).toBe(1);
    expect(eventCell.get()).toBe(1);
  });

  it("should handle events with nested paths", async () => {
    const parentCell = getDoc(
      { child: { value: 0 } },
      "should handle events with nested paths 1",
      "test",
    );
    let eventCount = 0;

    const eventHandler: EventHandler = () => {
      eventCount++;
    };

    addEventHandler(eventHandler, {
      cell: parentCell,
      path: ["child", "value"],
    });

    queueEvent({ cell: parentCell, path: ["child", "value"] }, 42);
    await idle();

    expect(eventCount).toBe(1);
  });

  it("should process events in order", async () => {
    const eventCell = getDoc(
      0,
      "should process events in order 1",
      "test",
    );
    const events: number[] = [];

    const eventHandler: EventHandler = (event) => {
      events.push(event);
    };

    addEventHandler(eventHandler, { cell: eventCell, path: [] });

    queueEvent({ cell: eventCell, path: [] }, 1);
    queueEvent({ cell: eventCell, path: [] }, 2);
    queueEvent({ cell: eventCell, path: [] }, 3);

    await idle();

    expect(events).toEqual([1, 2, 3]);
  });

  it("should trigger recomputation of dependent cells", async () => {
    const eventCell = getDoc(
      0,
      "should trigger recomputation of dependent cells 1",
      "test",
    );
    const eventResultCell = getDoc(
      0,
      "should trigger recomputation of dependent cells 2",
      "test",
    );
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
    await run(action);

    addEventHandler(eventHandler, { cell: eventCell, path: [] });

    expect(actionCount).toBe(1);

    queueEvent({ cell: eventCell, path: [] }, 1);
    await idle();

    expect(eventCount).toBe(1);
    expect(eventResultCell.get()).toBe(1);

    expect(actionCount).toBe(2);

    queueEvent({ cell: eventCell, path: [] }, 2);
    await idle();

    expect(eventCount).toBe(2);
    expect(eventResultCell.get()).toBe(2);
    expect(actionCount).toBe(3);
    expect(lastEventSeen).toBe(2);
  });
});

describe("compactifyPaths", () => {
  it("should compactify paths", () => {
    const testCell = getDoc({}, "should compactify paths 1", "test");
    const paths = [
      { cell: testCell, path: ["a", "b"] },
      { cell: testCell, path: ["a"] },
      { cell: testCell, path: ["c"] },
    ];
    const result = compactifyPaths(paths);
    expect(result).toEqual([
      { cell: testCell, path: ["a"] },
      { cell: testCell, path: ["c"] },
    ]);
  });

  it("should remove duplicate paths", () => {
    const testCell = getDoc(
      {},
      "should remove duplicate paths 1",
      "test",
    );
    const paths = [
      { cell: testCell, path: ["a", "b"] },
      { cell: testCell, path: ["a", "b"] },
    ];
    const result = compactifyPaths(paths);
    expect(result).toEqual([{ cell: testCell, path: ["a", "b"] }]);
  });

  it("should not compactify across cells", () => {
    const cellA = getDoc(
      {},
      "should not compactify across cells 1",
      "test",
    );
    const cellB = getDoc(
      {},
      "should not compactify across cells 2",
      "test",
    );
    const paths = [
      { cell: cellA, path: ["a", "b"] },
      { cell: cellB, path: ["a", "b"] },
    ];
    const result = compactifyPaths(paths);
    expect(result).toEqual(paths);
  });

  it("empty paths should trump all other ones", () => {
    const cellA = getDoc(
      {},
      "should remove duplicate paths 1",
      "test",
    );
    const paths = [
      { cell: cellA, path: ["a", "b"] },
      { cell: cellA, path: ["c"] },
      { cell: cellA, path: ["d"] },
      { cell: cellA, path: [] },
    ];
    const result = compactifyPaths(paths);
    expect(result).toEqual([{ cell: cellA, path: [] }]);
  });
});
