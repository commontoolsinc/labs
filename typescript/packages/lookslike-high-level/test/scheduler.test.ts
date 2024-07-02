import { describe, it, expect, vi } from "vitest";
import { cell, toValue } from "../src/runtime/cell.js";
import {
  Action,
  run,
  idle,
  remove,
  onError,
} from "../src/runtime/scheduler.js";

describe("scheduler", () => {
  it("should run actions when cells change", async () => {
    let runCount = 0;
    const a = cell(1);
    const b = cell(2);
    const c = cell(0);
    const adder: Action = (log) => {
      runCount++;
      c.withLog(log).send(toValue(a, log) + toValue(b, log));
    };
    run(adder);
    expect(runCount).toBe(1);
    expect(c.get()).toBe(3);
    a.send(2); // No log, simulate external change
    await idle();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);
  });

  it("should remove actions", async () => {
    let runCount = 0;
    const a = cell(1);
    const b = cell(2);
    const c = cell(0);
    const adder: Action = (log) => {
      runCount++;
      c.withLog(log).send(toValue(a, log) + toValue(b, log));
    };
    run(adder);
    expect(runCount).toBe(1);
    expect(c.get()).toBe(3);

    a.send(2);
    await idle();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);

    remove(adder);
    a.send(3);
    await idle();
    expect(runCount).toBe(2);
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
      c.withLog(log).send(toValue(a, log) + toValue(b, log));
    };
    const adder2: Action = (log) => {
      runs.push("adder2");
      e.withLog(log).send(toValue(c, log) + toValue(d, log));
    };
    run(adder1);
    run(adder2);
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
      c.withLog(log).send(toValue(a, log) + toValue(b, log));
    };
    const adder2: Action = (log) => {
      e.withLog(log).send(toValue(c, log) + toValue(d, log));
    };
    const adder3: Action = (log) => {
      if (--maxRuns <= 0) return;
      a.withLog(log).send(toValue(e, log) + toValue(b, log));
    };

    const stopped = vi.fn();
    onError(() => stopped());

    run(adder1);
    run(adder2);
    run(adder3);

    expect(stopped).not.toHaveBeenCalled();
    await idle();
    expect(stopped).toHaveBeenCalled();
    expect(maxRuns).toBeGreaterThan(0);
  });

  it("should not loop on r/w changes on its own output", async () => {
    const counter = cell(0);
    const by = cell(1);
    const inc: Action = (log) =>
      counter.withLog(log).send(toValue(counter, log) + toValue(by, log));

    const stopped = vi.fn();
    onError(() => stopped());

    run(inc);
    expect(counter.get()).toBe(1);
    await idle();
    expect(counter.get()).toBe(1);

    by.send(2);
    await idle();
    expect(counter.get()).toBe(3);

    expect(stopped).not.toHaveBeenCalled();
  });
});
