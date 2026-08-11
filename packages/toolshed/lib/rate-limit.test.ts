import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createRateLimiter } from "@/lib/rate-limit.ts";
import { clientKey } from "@/middlewares/rate-limit.ts";

// Toolshed had no rate limiting before self-serve minting, so this is the whole
// of it. The properties worth pinning are the ones an abuse bound depends on:
// that a burst is actually capped, that keys do not share a bucket, and that
// eviction cannot be used as a reset primitive.

describe("token bucket", () => {
  it("allows a burst up to capacity, then refuses", () => {
    const limiter = createRateLimiter({ capacity: 3, refillPerSecond: 0 });
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a")]).toEqual([
      true,
      true,
      true,
    ]);
    expect(limiter.take("a")).toBe(false);
  });

  it("keeps buckets per key", () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 0 });
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    // A different caller is unaffected by the first one's spend.
    expect(limiter.take("b")).toBe(true);
  });

  it("refills over time", () => {
    let clock = 0;
    const limiter = createRateLimiter({
      capacity: 1,
      refillPerSecond: 100,
      now: () => clock,
    });
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    clock += 10; // 100/s -> one token back after 10ms
    expect(limiter.take("a")).toBe(true);
  });

  it("never refills past capacity", () => {
    let clock = 0;
    const limiter = createRateLimiter({
      capacity: 2,
      refillPerSecond: 1000,
      now: () => clock,
    });
    clock += 60_000; // a minute of idle must not bank more than the burst
    expect([limiter.take("a"), limiter.take("a")]).toEqual([true, true]);
    expect(limiter.take("a")).toBe(false);
  });

  // The LRU exists so the limiter cannot become the memory exhaustion it
  // prevents. It has a sharp edge: an evicted key gets a fresh full bucket, so
  // a flood of distinct keys is a reset primitive against a throttled one. The
  // defence is the size of maxKeys, and this pins that the eviction is real.
  it("evicts the least recently used key once maxKeys is exceeded", () => {
    const limiter = createRateLimiter({
      capacity: 1,
      refillPerSecond: 0,
      maxKeys: 2,
    });
    expect(limiter.take("old")).toBe(true);
    expect(limiter.take("old")).toBe(false);

    limiter.take("b");
    limiter.take("c"); // pushes "old" out

    // "old" is a fresh bucket again, which is the documented trade-off.
    expect(limiter.take("old")).toBe(true);
  });
});

describe("clientKey", () => {
  // `getConnInfo` throws when there is no Deno connection behind the request,
  // which is exactly the case under `app.request`; it must not take the route
  // down with it.
  it("survives a context with no connection info", () => {
    expect(clientKey({ req: { header: () => undefined } })).toBe("unknown");
  });

  const req = (headers: Record<string, string>) => ({
    req: { header: (name: string) => headers[name.toLowerCase()] },
  });

  // .env.test sets RATE_LIMIT_TRUST_FORWARDED_FOR=true, so this exercises the
  // trusted-proxy branch.
  // The RIGHTMOST entry. A proxy appends what it saw to whatever the request
  // already carried, so everything to its left is client-authored.
  it("takes the rightmost X-Forwarded-For entry when a proxy is trusted", () => {
    expect(
      clientKey(req({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" })),
    ).toBe("10.0.0.2");
  });

  // The property that matters: a caller cannot choose their own bucket. Taking
  // the leftmost entry made every request from one client look like a different
  // one, which is the limiter not existing.
  it("gives a client no way to pick its own bucket by forging the header", () => {
    const proxySaw = "10.0.0.2";
    const forged = ["evil-1", "evil-2", "evil-3"].map((spoof) =>
      clientKey(req({ "x-forwarded-for": `${spoof}, ${proxySaw}` }))
    );
    expect(new Set(forged).size).toBe(1);
    expect(forged[0]).toBe(proxySaw);
  });

  it("falls back to unknown when there is no header and no connection info", () => {
    expect(clientKey(req({}))).toBe("unknown");
  });
});
