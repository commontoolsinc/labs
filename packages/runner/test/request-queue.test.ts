import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { RequestQueue } from "../src/builtins/request-queue.ts";

describe("RequestQueue", () => {
  it("should run tasks immediately when below max concurrency", async () => {
    const queue = new RequestQueue(3);
    const results: number[] = [];

    await Promise.all([
      queue.run(async () => {
        results.push(1);
      }),
      queue.run(async () => {
        results.push(2);
      }),
      queue.run(async () => {
        results.push(3);
      }),
    ]);

    expect(results).toHaveLength(3);
    expect(results).toContain(1);
    expect(results).toContain(2);
    expect(results).toContain(3);
  });

  it("should enforce max concurrency", async () => {
    const queue = new RequestQueue(2);
    let peakConcurrency = 0;
    let currentConcurrency = 0;

    const task = () =>
      queue.run(async () => {
        currentConcurrency++;
        peakConcurrency = Math.max(peakConcurrency, currentConcurrency);
        await new Promise((resolve) => setTimeout(resolve, 50));
        currentConcurrency--;
      });

    await Promise.all([task(), task(), task(), task(), task()]);

    expect(peakConcurrency).toBe(2);
  });

  it("should release slots on error so subsequent tasks can run", async () => {
    const queue = new RequestQueue(1);
    const results: string[] = [];

    // First task throws
    await queue.run(async () => {
      throw new Error("fail");
    }).catch(() => {
      results.push("caught");
    });

    // Second task should still get a slot
    await queue.run(async () => {
      results.push("ok");
    });

    expect(results).toEqual(["caught", "ok"]);
  });

  it("should process queued tasks in FIFO order", async () => {
    const queue = new RequestQueue(1);
    const order: number[] = [];

    // Fill the single slot with a slow task
    const blocker = queue.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      order.push(0);
    });

    // These will queue in order
    const t1 = queue.run(async () => {
      order.push(1);
    });
    const t2 = queue.run(async () => {
      order.push(2);
    });
    const t3 = queue.run(async () => {
      order.push(3);
    });

    await Promise.all([blocker, t1, t2, t3]);

    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("should return the value from the wrapped function", async () => {
    const queue = new RequestQueue(2);

    const result = await queue.run(async () => 42);
    expect(result).toBe(42);

    const result2 = await queue.run(async () => "hello");
    expect(result2).toBe("hello");
  });

  it("should propagate errors from the wrapped function", async () => {
    const queue = new RequestQueue(2);

    await expect(
      queue.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("should handle maxConcurrency of 1 as a serial queue", async () => {
    const queue = new RequestQueue(1);
    const events: string[] = [];

    const t1 = queue.run(async () => {
      events.push("t1-start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      events.push("t1-end");
    });

    const t2 = queue.run(async () => {
      events.push("t2-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push("t2-end");
    });

    await Promise.all([t1, t2]);

    // t2 should not start until t1 ends
    expect(events.indexOf("t1-end")).toBeLessThan(events.indexOf("t2-start"));
  });

  it("should drain all waiting tasks after burst", async () => {
    const queue = new RequestQueue(2);
    let completed = 0;

    const tasks = Array.from({ length: 10 }, () =>
      queue.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        completed++;
      })
    );

    await Promise.all(tasks);
    expect(completed).toBe(10);
  });
});
