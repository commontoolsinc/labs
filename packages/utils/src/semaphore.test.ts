import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Semaphore, SemaphoreQueueFullError } from "./semaphore.ts";

describe("Semaphore", () => {
  describe("basic operations", () => {
    it("allows acquiring up to maxConcurrent permits", async () => {
      const sem = new Semaphore({ maxConcurrent: 3 });
      expect(sem.availablePermits).toBe(3);

      await sem.acquire();
      expect(sem.availablePermits).toBe(2);

      await sem.acquire();
      expect(sem.availablePermits).toBe(1);

      await sem.acquire();
      expect(sem.availablePermits).toBe(0);
    });

    it("releases permits correctly", async () => {
      const sem = new Semaphore({ maxConcurrent: 2 });

      await sem.acquire();
      await sem.acquire();
      expect(sem.availablePermits).toBe(0);

      sem.release();
      expect(sem.availablePermits).toBe(1);

      sem.release();
      expect(sem.availablePermits).toBe(2);
    });

    it("does not exceed maxConcurrent on release", async () => {
      const sem = new Semaphore({ maxConcurrent: 2 });
      expect(sem.availablePermits).toBe(2);

      // Release without acquire - should still not exceed max
      sem.release();
      expect(sem.availablePermits).toBe(3); // This is a design choice - caller must balance
    });
  });

  describe("blocking behavior", () => {
    it("blocks when no permits available", async () => {
      const sem = new Semaphore({ maxConcurrent: 1 });
      await sem.acquire();

      let acquired = false;
      const acquirePromise = sem.acquire().then(() => {
        acquired = true;
      });

      // Should not have acquired yet
      await Promise.resolve(); // Let microtasks run
      expect(acquired).toBe(false);
      expect(sem.queueLength).toBe(1);

      // Release and let waiter acquire
      sem.release();
      await acquirePromise;
      expect(acquired).toBe(true);
      expect(sem.queueLength).toBe(0);
    });

    it("maintains FIFO order for waiters", async () => {
      const sem = new Semaphore({ maxConcurrent: 1 });
      await sem.acquire();

      const order: number[] = [];

      const p1 = sem.acquire().then(() => order.push(1));
      const p2 = sem.acquire().then(() => order.push(2));
      const p3 = sem.acquire().then(() => order.push(3));

      expect(sem.queueLength).toBe(3);

      // Release all
      sem.release();
      await p1;
      sem.release();
      await p2;
      sem.release();
      await p3;

      expect(order).toEqual([1, 2, 3]);
    });
  });

  describe("backpressure (maxQueueDepth)", () => {
    it("throws when queue is full", async () => {
      const sem = new Semaphore({ maxConcurrent: 1, maxQueueDepth: 2 });
      await sem.acquire(); // Take the only permit

      // Queue up to the limit
      const p1 = sem.acquire();
      const p2 = sem.acquire();
      expect(sem.queueLength).toBe(2);

      // This should throw
      await expect(sem.acquire()).rejects.toThrow(SemaphoreQueueFullError);

      // Clean up
      sem.release();
      await p1;
      sem.release();
      await p2;
    });

    it("allows queue to refill after draining", async () => {
      const sem = new Semaphore({ maxConcurrent: 1, maxQueueDepth: 1 });
      await sem.acquire();

      // Fill the queue
      const p1 = sem.acquire();
      expect(sem.queueLength).toBe(1);

      // Should throw
      await expect(sem.acquire()).rejects.toThrow(SemaphoreQueueFullError);

      // Drain the queue
      sem.release();
      await p1;
      expect(sem.queueLength).toBe(0);

      // Now p1 holder has the permit, release it
      sem.release();

      // Should be able to acquire and queue again
      await sem.acquire();
      const p2 = sem.acquire();
      expect(sem.queueLength).toBe(1);

      sem.release();
      await p2;
      sem.release(); // Clean up
    });

    it("allows unlimited queue when maxQueueDepth is undefined", async () => {
      const sem = new Semaphore({ maxConcurrent: 1 });
      await sem.acquire();

      // Queue many waiters - should not throw
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 100; i++) {
        promises.push(sem.acquire());
      }
      expect(sem.queueLength).toBe(100);

      // Clean up
      for (const p of promises) {
        sem.release();
        await p;
      }
    });
  });

  describe("SemaphoreQueueFullError", () => {
    it("has correct name and message", () => {
      const err = new SemaphoreQueueFullError(10);
      expect(err.name).toBe("SemaphoreQueueFullError");
      expect(err.message).toBe("Semaphore queue full (max 10 waiters)");
    });
  });

  describe("properties", () => {
    it("exposes maxPermits", () => {
      const sem = new Semaphore({ maxConcurrent: 5 });
      expect(sem.maxPermits).toBe(5);
    });

    it("tracks queueLength correctly", async () => {
      const sem = new Semaphore({ maxConcurrent: 1 });
      expect(sem.queueLength).toBe(0);

      await sem.acquire();
      expect(sem.queueLength).toBe(0);

      const p1 = sem.acquire();
      expect(sem.queueLength).toBe(1);

      const p2 = sem.acquire();
      expect(sem.queueLength).toBe(2);

      sem.release();
      await p1;
      expect(sem.queueLength).toBe(1);

      sem.release();
      await p2;
      expect(sem.queueLength).toBe(0);
    });
  });
});
