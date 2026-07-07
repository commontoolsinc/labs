import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  sleep,
  timeout,
  unrefTimer,
  yieldToEventLoop,
} from "@commonfabric/utils/sleep";

/** Hold the event loop synchronously for ~ms, like a CPU-bound compile step. */
const busySpin = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // burn
  }
};

describe("sleep", () => {
  it("resolves after the given timeout", async () => {
    const start = performance.now();
    await sleep(5);
    // Timers never fire early; keep the bound loose so the test cannot flake.
    expect(performance.now() - start).toBeGreaterThanOrEqual(4);
  });
});

describe("timeout", () => {
  it("rejects with the given message after the timeout", async () => {
    await expect(timeout(1, "took too long")).rejects.toThrow("took too long");
  });
});

describe("yieldToEventLoop", () => {
  it("runs a message task queued before the yield ahead of the continuation", async () => {
    // Awaiting a resolved promise only yields a MICROtask, which would leave
    // this already-queued message event unhandled. yieldToEventLoop must be a
    // real macrotask turn through the posted-message task source, so the
    // message queued BEFORE the yield runs BEFORE the continuation.
    const order: string[] = [];
    const { port1, port2 } = new MessageChannel();
    const delivered = new Promise<void>((resolve) => {
      port1.onmessage = () => {
        order.push("queued-message");
        resolve();
      };
    });
    port2.postMessage(null);

    await yieldToEventLoop();
    order.push("continuation");

    await delivered;
    port1.close();
    port2.close();
    expect(order).toEqual(["queued-message", "continuation"]);
  });

  it("lets due timers fire across a yield chain (timer-turn budget)", async () => {
    // A pure posted-message chain starves timers on some hosts (measured in
    // Deno: an armed interval never fires behind a MessageChannel chain).
    // Every TIMER_TURN_BUDGET_MS the yield additionally takes one
    // setTimeout(0) hop, so a long CPU-bound loop that yields between steps
    // still lets due timers run. Spin a few ms per iteration so the budget
    // elapses and the hop is taken within a bounded number of yields.
    let ticks = 0;
    const id = setInterval(() => {
      ticks++;
    }, 1);
    try {
      for (let i = 0; i < 20 && ticks === 0; i++) {
        busySpin(3);
        await yieldToEventLoop();
      }
    } finally {
      clearInterval(id);
    }
    expect(ticks).toBeGreaterThan(0);
  });

  it("falls back to a plain timeout when MessageChannel is unavailable", async () => {
    const holder = globalThis as { MessageChannel?: unknown };
    const original = holder.MessageChannel;
    holder.MessageChannel = undefined;
    try {
      // The fallback must not touch MessageChannel at all: reaching the
      // message path with the constructor stubbed away would throw.
      await yieldToEventLoop();
    } finally {
      holder.MessageChannel = original;
    }
    expect(typeof MessageChannel).toBe("function");
  });
});

describe("unrefTimer", () => {
  it("returns the id and is safe to call on a live interval", () => {
    const id = setInterval(() => {}, 60_000);
    try {
      expect(unrefTimer(id)).toBe(id);
    } finally {
      clearInterval(id);
    }
  });

  it("detaches the timer through Deno.unrefTimer", () => {
    const deno = (globalThis as {
      Deno?: { unrefTimer?: (id: number) => void };
    }).Deno!;
    const original = deno.unrefTimer!;
    const seen: number[] = [];
    deno.unrefTimer = (id: number) => {
      seen.push(id);
      original(id);
    };
    let id: ReturnType<typeof setInterval> | undefined;
    try {
      id = setInterval(() => {}, 60_000);
      const returned = unrefTimer(id);
      expect(returned).toBe(id);
      expect(seen).toEqual([id as unknown as number]);
    } finally {
      deno.unrefTimer = original;
      if (id !== undefined) clearInterval(id);
    }
  });

  it("is a no-op that still returns the id when Deno.unrefTimer is unavailable", () => {
    // In the browser there is no Deno namespace; the nearest equivalent here
    // is a Deno namespace without unrefTimer. The call must not throw and
    // must still hand the id back for chaining.
    const deno = (globalThis as { Deno?: { unrefTimer?: unknown } }).Deno!;
    const original = deno.unrefTimer;
    deno.unrefTimer = undefined;
    try {
      const id = setInterval(() => {}, 60_000);
      try {
        expect(unrefTimer(id)).toBe(id);
      } finally {
        clearInterval(id);
      }
    } finally {
      deno.unrefTimer = original;
    }
  });
});
