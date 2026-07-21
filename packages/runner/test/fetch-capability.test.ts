// Channel-7 closure: the sandbox `fetch` is capability-gated (handler-only) and
// its settlement is coarsened to the wall-clock grid, so a pattern's imperative
// network access carries no fine clock. See createGatedFetch in
// sandbox/compartment-globals.ts and docs/specs/sandboxing/TIMING_SIDE_CHANNELS.md.
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  createGatedFetch,
  createModuleCompartmentGlobals,
} from "../src/sandbox/compartment-globals.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { ensureSESLockdown } from "../src/sandbox/ses-runtime.ts";

// The gate reads the lift-vs-handler context from the active frame; exercise it
// by pushing a frame with or without `inHandler`.
async function inFrame<T>(
  props: { inHandler?: boolean },
  fn: () => Promise<T>,
): Promise<T> {
  const frame = pushFrame({
    ...(props.inHandler ? { inHandler: true } : {}),
  });
  try {
    return await fn();
  } finally {
    popFrame(frame);
  }
}

// A gated fetch with virtual time: `now` is fixed and `wait` resolves
// immediately while recording the requested delay, so the grid arithmetic and
// settle ordering are asserted without real timers.
function virtualGatedFetch(
  hostFetch: typeof fetch,
  nowMs: number,
  gridMs = 1000,
): { gated: typeof fetch; waits: number[] } {
  const waits: number[] = [];
  const gated = createGatedFetch(hostFetch, {
    gridMs,
    now: () => nowMs,
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  return { gated, waits };
}

describe("channel 7: gated sandbox fetch", () => {
  it("throws TimeCapabilityError with no frame, without starting a request", async () => {
    let called = 0;
    const { gated } = virtualGatedFetch(
      (() => {
        called += 1;
        return Promise.resolve(new Response("x"));
      }) as typeof fetch,
      500,
    );
    await expect(gated("https://example.test/")).rejects.toMatchObject({
      name: "TimeCapabilityError",
    });
    expect(called).toBe(0);
  });

  it("throws in a non-handler (lift/body) frame, without starting a request", async () => {
    let called = 0;
    const { gated } = virtualGatedFetch(
      (() => {
        called += 1;
        return Promise.resolve(new Response("x"));
      }) as typeof fetch,
      500,
    );
    await inFrame({}, async () => {
      await expect(gated("https://example.test/")).rejects.toMatchObject({
        name: "TimeCapabilityError",
      });
    });
    expect(called).toBe(0);
  });

  it("resolves in a handler frame with a fully buffered, faithful response", async () => {
    const hostFetch = (() => {
      const res = new Response(JSON.stringify({ ok: true, n: 7 }), {
        status: 201,
        statusText: "Created",
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "content-length": "999",
          "x-custom": "yes",
        },
      });
      Object.defineProperty(res, "url", { value: "https://example.test/api" });
      Object.defineProperty(res, "redirected", { value: true });
      return Promise.resolve(res);
    }) as typeof fetch;
    const { gated } = virtualGatedFetch(hostFetch, 500);

    await inFrame({ inHandler: true }, async () => {
      const res = await gated("https://example.test/api");
      expect(res.status).toBe(201);
      expect(res.statusText).toBe("Created");
      expect(res.ok).toBe(true);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(res.headers.get("x-custom")).toBe("yes");
      // Wire-form headers are dropped: they describe the transport encoding,
      // not the buffered body handed to the pattern.
      expect(res.headers.get("content-encoding")).toBe(null);
      expect(res.headers.get("content-length")).toBe(null);
      expect(res.url).toBe("https://example.test/api");
      expect(res.redirected).toBe(true);
      // clone() before consuming, like retrying clients do.
      const clone = res.clone();
      expect(await res.json()).toEqual({ ok: true, n: 7 });
      expect(await clone.text()).toBe(JSON.stringify({ ok: true, n: 7 }));
    });
  });

  it("handles null-body statuses (204)", async () => {
    const hostFetch = (() =>
      Promise.resolve(
        new Response(null, { status: 204 }),
      )) as typeof fetch;
    const { gated } = virtualGatedFetch(hostFetch, 500);
    await inFrame({ inHandler: true }, async () => {
      const res = await gated("https://example.test/");
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
    });
  });

  it("settles on the wall-clock grid (fulfillment)", async () => {
    const hostFetch =
      (() => Promise.resolve(new Response("body"))) as typeof fetch;
    // Virtual `now` is fixed, so issue and arrival coincide (latency 0): the
    // settlement is one grid step past the issue boundary — issue 1234, issue
    // boundary 1000, settle 2000 -> wait 766.
    const { gated, waits } = virtualGatedFetch(hostFetch, 1234, 1000);
    await inFrame({ inHandler: true }, async () => {
      await gated("https://example.test/");
    });
    expect(waits).toEqual([766]);
  });

  it("settles on the wall-clock grid (rejection), propagating the error", async () => {
    const failure = new Error("connection refused");
    const hostFetch = (() => Promise.reject(failure)) as typeof fetch;
    // Latency 0: issue 250, issue boundary 0, settle 1000 -> wait 750. The
    // rejection path uses the same issue-relative settlement as fulfillment.
    const { gated, waits } = virtualGatedFetch(hostFetch, 250, 1000);
    await inFrame({ inHandler: true }, async () => {
      await expect(gated("https://example.test/")).rejects.toBe(failure);
    });
    expect(waits).toEqual([750]);
  });

  it("settles independently of the sub-second issue phase (no phase leak)", async () => {
    // A fetch issued at phase p within a second, with a known round trip R,
    // must settle at the SAME wall-clock boundary regardless of p — otherwise
    // the handler continuation could read that boundary off the coarse clock
    // and binary-search p by varying R (the residual channel-7 leak). `now`
    // returns the issue instant first, then the arrival instant (issue + R).
    const settlementInstant = async (
      issueMs: number,
      rMs: number,
    ): Promise<number> => {
      const times = [issueMs, issueMs + rMs];
      let call = 0;
      let waited = 0;
      const gated = createGatedFetch(
        (() => Promise.resolve(new Response("x"))) as typeof fetch,
        {
          gridMs: 1000,
          now: () => times[Math.min(call++, times.length - 1)],
          wait: (ms) => {
            waited = ms;
            return Promise.resolve();
          },
        },
      );
      await inFrame({ inHandler: true }, async () => {
        await gated("https://example.test/");
      });
      return issueMs + rMs + waited;
    };

    const R = 500;
    // Two issues in the SAME coarse second (10000) at different phases.
    const early = await settlementInstant(10_100, R); // phase 100ms
    const late = await settlementInstant(10_700, R); // phase 700ms
    expect(early).toBe(late); // phase-independent settlement
    expect(early % 1000).toBe(0); // on the grid
    // Contrast: a larger round trip shifts settlement by whole grid steps only
    // (the coarse round-trip band is not hidden), still phase-independent.
    const slowEarly = await settlementInstant(10_100, 1500);
    const slowLate = await settlementInstant(10_800, 1500);
    expect(slowEarly).toBe(slowLate);
    expect(slowLate).toBeGreaterThan(late);
  });

  it("does not settle before the grid wait resolves", async () => {
    let releaseWait!: () => void;
    const waitGate = new Promise<void>((resolve) => (releaseWait = resolve));
    const gated = createGatedFetch(
      (() => Promise.resolve(new Response("x"))) as typeof fetch,
      { gridMs: 1000, now: () => 100, wait: () => waitGate },
    );
    await inFrame({ inHandler: true }, async () => {
      let settled = false;
      const pending = gated("https://example.test/").then(() => {
        settled = true;
      });
      // Give the fetch every chance to (incorrectly) settle early.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(settled).toBe(false);
      releaseWait();
      await pending;
      expect(settled).toBe(true);
    });
  });

  it("is the injected sandbox fetch, not the host fetch", async () => {
    ensureSESLockdown();
    const globals = createModuleCompartmentGlobals();
    expect(typeof globals.fetch).toBe("function");
    expect(globals.fetch).not.toBe(globalThis.fetch);
    // Outside any frame the injected fetch denies the request outright.
    await expect(
      (globals.fetch as typeof fetch)("https://example.test/"),
    ).rejects.toMatchObject({ name: "TimeCapabilityError" });
  });
});
