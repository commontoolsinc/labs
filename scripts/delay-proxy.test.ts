import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { LinkScheduler } from "./delay-proxy.ts";

describe("LinkScheduler", () => {
  it("delays an isolated chunk by the propagation delay", () => {
    const link = new LinkScheduler(95, 0);
    expect(link.enqueue(1000, 5000)).toBe(1095);
  });

  it("keeps uncapped chunks on their own arrival times regardless of backlog", () => {
    const link = new LinkScheduler(95, 0);
    expect(link.enqueue(0, 64 * 1024)).toBe(95);
    expect(link.enqueue(10, 64 * 1024)).toBe(105);
    expect(link.enqueue(10, 64 * 1024)).toBe(105);
  });

  it("serializes capped chunks back-to-back with no idle gap", () => {
    const link = new LinkScheduler(95, 1000);
    expect(link.enqueue(0, 500)).toBe(595);
    expect(link.enqueue(0, 500)).toBe(1095);
    expect(link.enqueue(0, 500)).toBe(1595);
  });

  it("restarts from the arrival time after the link has gone idle", () => {
    const link = new LinkScheduler(95, 1000);
    expect(link.enqueue(0, 500)).toBe(595);
    expect(link.enqueue(10000, 500)).toBe(10595);
  });

  it("pauses at the high-water mark and resumes only below low water", () => {
    const link = new LinkScheduler(95, 1000, 300, 150);
    link.enqueue(0, 100);
    link.enqueue(0, 100);
    expect(link.shouldPause()).toBe(false);
    link.enqueue(0, 100);
    expect(link.shouldPause()).toBe(true);
    link.complete(100);
    expect(link.canResume()).toBe(false);
    link.complete(100);
    expect(link.canResume()).toBe(true);
  });

  it("emits a gapless schedule across several pause windows", () => {
    // 100 B chunks over a 1000 B/s link take 100 ms each; the marks force a
    // pause every third chunk. A correct schedule is indistinguishable from
    // never pausing: consecutive write instants exactly one transmission
    // apart, and the backlog never above the high-water mark. Completions are
    // replayed in ready order, as the pump's ordered chain delivers them.
    const link = new LinkScheduler(95, 1000, 300, 250);
    const pendingCompletions: Array<{ ready: number; bytes: number }> = [];
    const readies: number[] = [];
    let clock = 0;
    for (let i = 0; i < 20; i++) {
      if (link.shouldPause()) {
        do {
          const done = pendingCompletions.shift()!;
          clock = Math.max(clock, done.ready);
          link.complete(done.bytes);
        } while (!link.canResume());
      }
      expect(link.queuedBytes).toBeLessThanOrEqual(300);
      const ready = link.enqueue(clock, 100);
      pendingCompletions.push({ ready, bytes: 100 });
      readies.push(ready);
    }
    for (let i = 1; i < readies.length; i++) {
      expect(readies[i] - readies[i - 1]).toBe(100);
    }
    expect(readies[0]).toBe(195);
    expect(readies[19]).toBe(195 + 19 * 100);
  });
});
