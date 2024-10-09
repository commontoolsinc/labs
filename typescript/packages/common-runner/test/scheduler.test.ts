import { describe, it, expect, vi } from "vitest";
import { cell, ReactivityLog } from "../src/cell.js";
import {
  Action,
  run,
  schedule,
  idle,
  unschedule,
  onError,
  addEventHandler,
  queueEvent,
  EventHandler,
} from "../src/scheduler.js";
import { lift } from "@commontools/common-builder";

describe("scheduler", () => {
  it("should run actions when cells change", async () => {
    let runCount = 0;
    const a = cell(1);
    const b = cell(2);
    const c = cell(0);
    const adder: Action = (log) => {
      runCount++;
      c.asSimpleCell([], log).send(
        a.getAsProxy([], log) + b.getAsProxy([], log)
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
    const a = cell(1);
    const b = cell(2);
    const c = cell(0);
    const adder: Action = (log) => {
      runCount++;
      c.asSimpleCell([], log).send(
        a.getAsProxy([], log) + b.getAsProxy([], log)
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
    const a = cell(1);
    const b = cell(2);
    const c = cell(0);
    const adder: Action = (log) => {
      runCount++;
      c.asSimpleCell([], log).send(
        a.getAsProxy([], log) + b.getAsProxy([], log)
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
    const a = cell(1);
    const b = cell(2);
    const c = cell(0);
    const adder: Action = (log) => {
      runCount++;
      c.asSimpleCell([], log).send(
        a.getAsProxy([], log) + b.getAsProxy([], log)
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
    const a = cell(1);
    const b = cell(2);
    const c = cell(0);
    const d = cell(1);
    const e = cell(0);
    const adder1: Action = (log) => {
      runs.push("adder1");
      c.asSimpleCell([], log).send(
        a.getAsProxy([], log) + b.getAsProxy([], log)
      );
    };
    const adder2: Action = (log) => {
      runs.push("adder2");
      e.asSimpleCell([], log).send(
        c.getAsProxy([], log) + d.getAsProxy([], log)
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
    const a = cell(1);
    const b = cell(2);
    const c = cell(0);
    const d = cell(1);
    const e = cell(0);
    const adder1: Action = (log) => {
      c.asSimpleCell([], log).send(
        a.getAsProxy([], log) + b.getAsProxy([], log)
      );
    };
    const adder2: Action = (log) => {
      e.asSimpleCell([], log).send(
        c.getAsProxy([], log) + d.getAsProxy([], log)
      );
    };
    const adder3: Action = (log) => {
      if (--maxRuns <= 0) return;
      c.asSimpleCell([], log).send(
        e.getAsProxy([], log) + b.getAsProxy([], log)
      );
    };

    const stopped = vi.fn();
    onError(() => stopped());

    await run(adder1);
    await run(adder2);
    await run(adder3);

    await idle();

    expect(maxRuns).toBeGreaterThan(0);
    expect(stopped).toHaveBeenCalled();
  });

  it("should not loop on r/w changes on its own output", async () => {
    const counter = cell(0);
    const by = cell(1);
    const inc: Action = (log) =>
      counter
        .asSimpleCell([], log)
        .send(counter.getAsProxy([], log) + by.getAsProxy([], log));

    const stopped = vi.fn();
    onError(() => stopped());

    await run(inc);
    expect(counter.get()).toBe(1);
    await idle();
    expect(counter.get()).toBe(1);

    by.send(2);
    await idle();
    expect(counter.get()).toBe(3);

    expect(stopped).not.toHaveBeenCalled();
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
    const eventCell = cell(0);
    const eventResultCell = cell(0);
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
    const eventCell = cell(0);
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
    const parentCell = cell({ child: { value: 0 } });
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
    const eventCell = cell(0);
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
    const eventCell = cell(0);
    const eventResultCell = cell(0);
    let eventCount = 0;
    let actionCount = 0;
    let lastEventSeen = 0;

    const eventHandler: EventHandler = (event) => {
      eventCount++;
      eventResultCell.send(event);
    };

    const action = (log: ReactivityLog) => {
      actionCount++;
      lastEventSeen = eventResultCell.getAsProxy([], log);
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
