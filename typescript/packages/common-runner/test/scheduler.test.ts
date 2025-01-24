import { describe, it } from "jsr:@std/testing/bdd";
import { assertSpyCalls, spy } from "jsr:@std/testing/mock";
import { expect } from "jsr:@std/expect";
import { getDoc, ReactivityLog } from "../src/cell.ts";
import {
  Action,
  addEventHandler,
  EventHandler,
  idle,
  onError,
  queueEvent,
  run,
  schedule,
  unschedule,
} from "../src/scheduler.ts";
import { lift } from "@commontools/builder";

describe("scheduler", () => {
  it("should run actions when cells change", async () => {
    let runCount = 0;
    const a = getDoc(1);
    const b = getDoc(2);
    const c = getDoc(0);
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
    const a = getDoc(1);
    const b = getDoc(2);
    const c = getDoc(0);
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
    const a = getDoc(1);
    const b = getDoc(2);
    const c = getDoc(0);
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
    const a = getDoc(1);
    const b = getDoc(2);
    const c = getDoc(0);
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
    let runs: string[] = [];
    const a = getDoc(1);
    const b = getDoc(2);
    const c = getDoc(0);
    const d = getDoc(1);
    const e = getDoc(0);
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
    let maxRuns = 200; // More than the limit in scheduler
    const a = getDoc(1);
    const b = getDoc(2);
    const c = getDoc(0);
    const d = getDoc(1);
    const e = getDoc(0);
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

    const stopped = spy();
    onError(() => stopped());

    await run(adder1);
    await run(adder2);
    await run(adder3);

    await idle();

    expect(maxRuns).toBeGreaterThan(0);
    assertSpyCalls(stopped, 1);
  });

  it("should not loop on r/w changes on its own output", async () => {
    const counter = getDoc(0);
    const by = getDoc(1);
    const inc: Action = (log) =>
      counter
        .asCell([], log)
        .send(counter.getAsQueryResult([], log) + by.getAsQueryResult([], log));

    const stopped = spy();
    onError(() => stopped());

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
    const eventCell = getDoc(0);
    const eventResultCell = getDoc(0);
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
    const eventCell = getDoc(0);
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
    const parentCell = getDoc({ child: { value: 0 } });
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
    const eventCell = getDoc(0);
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
    const eventCell = getDoc(0);
    const eventResultCell = getDoc(0);
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
