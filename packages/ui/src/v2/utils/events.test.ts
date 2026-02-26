import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import { debounce, EventManager, throttle } from "./events.ts";

// ---------------------------------------------------------------------------
// debounce
// ---------------------------------------------------------------------------

describe("debounce", () => {
  let time: FakeTime;

  beforeEach(() => {
    time = new FakeTime();
  });
  afterEach(() => {
    time.restore();
  });

  it("delays invocation until after wait period", () => {
    const calls: number[] = [];
    const fn = debounce((x: number) => calls.push(x), 100);

    fn(1);
    expect(calls).toEqual([]);
    time.tick(100);
    expect(calls).toEqual([1]);
  });

  it("resets timer on repeated calls", () => {
    const calls: number[] = [];
    const fn = debounce((x: number) => calls.push(x), 100);

    fn(1);
    time.tick(80);
    fn(2);
    time.tick(80);
    expect(calls).toEqual([]); // still waiting
    time.tick(20);
    expect(calls).toEqual([2]); // only last call fires
  });

  it("can fire multiple times with enough delay between", () => {
    const calls: number[] = [];
    const fn = debounce((x: number) => calls.push(x), 50);

    fn(1);
    time.tick(50);
    fn(2);
    time.tick(50);
    expect(calls).toEqual([1, 2]);
  });

  it("preserves this binding", () => {
    const obj = {
      value: 0,
      update: debounce(function (this: { value: number }, v: number) {
        this.value = v;
      }, 50),
    };
    obj.update(42);
    time.tick(50);
    expect(obj.value).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// throttle
// ---------------------------------------------------------------------------

describe("throttle", () => {
  let time: FakeTime;

  beforeEach(() => {
    time = new FakeTime();
  });
  afterEach(() => {
    time.restore();
  });

  it("fires immediately on first call", () => {
    const calls: number[] = [];
    const fn = throttle((x: number) => calls.push(x), 100);

    fn(1);
    expect(calls).toEqual([1]);
  });

  it("suppresses calls within the throttle window", () => {
    const calls: number[] = [];
    const fn = throttle((x: number) => calls.push(x), 100);

    fn(1);
    fn(2);
    fn(3);
    expect(calls).toEqual([1]); // only first fires
  });

  it("allows calls after the throttle window expires", () => {
    const calls: number[] = [];
    const fn = throttle((x: number) => calls.push(x), 100);

    fn(1);
    time.tick(100);
    fn(2);
    expect(calls).toEqual([1, 2]);
  });

  it("preserves this binding", () => {
    const obj = {
      value: 0,
      update: throttle(function (this: { value: number }, v: number) {
        this.value = v;
      }, 50),
    };
    obj.update(42);
    expect(obj.value).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// EventManager
// ---------------------------------------------------------------------------

describe("EventManager", () => {
  it("adds and tracks listeners", () => {
    const manager = new EventManager();
    const target = new EventTarget();
    const calls: string[] = [];

    manager.add(target, "test", () => calls.push("heard"));
    target.dispatchEvent(new Event("test"));
    expect(calls).toEqual(["heard"]);
  });

  it("removeAll removes all tracked listeners", () => {
    const manager = new EventManager();
    const target = new EventTarget();
    const calls: string[] = [];

    manager.add(target, "test", () => calls.push("a"));
    manager.add(target, "other", () => calls.push("b"));
    manager.removeAll();

    target.dispatchEvent(new Event("test"));
    target.dispatchEvent(new Event("other"));
    expect(calls).toEqual([]);
  });

  it("remove removes a specific listener", () => {
    const manager = new EventManager();
    const target = new EventTarget();
    const calls: string[] = [];

    const listenerA = () => calls.push("a");
    const listenerB = () => calls.push("b");

    manager.add(target, "test", listenerA);
    manager.add(target, "test", listenerB);

    manager.remove(target, "test", listenerA);
    target.dispatchEvent(new Event("test"));
    expect(calls).toEqual(["b"]); // only B remains
  });

  it("remove is a no-op for untracked listener", () => {
    const manager = new EventManager();
    const target = new EventTarget();
    // Should not throw
    manager.remove(target, "test", () => {});
  });
});
