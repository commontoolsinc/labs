// prod-uptime tests: the tile's only source is a fetch of the production URL, so
// every case here is a canned response (or a canned failure) plus a clock that
// advances by a set latency across the round trip. No real network.
import { assertEquals, assertRejects } from "@std/assert";
import type { Ctx } from "../types.ts";
import {
  prodUptime,
  setProdUptimeHttpClientFactoryForTest,
} from "./prod-uptime.ts";

type ProxyFetchInit = RequestInit & { client?: Deno.HttpClient };

function ctx(env: Record<string, string> = {}): Ctx {
  return {
    runs: () => Promise.resolve([]),
    runsFor: () => Promise.resolve([]),
    env: (k) => env[k],
  };
}

// Replaces fetch and the clock for one test. `reply` returns the canned response,
// or throws to stand in for an unreachable host. The clock jumps by `latencyMs`
// when fetch is called, which is what the tile measures as the round trip.
function stub(
  reply: (url: string, init: ProxyFetchInit | undefined) => Response,
  latencyMs = 12,
) {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    now += latencyMs;
    return Promise.resolve(reply(String(input), init));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  };
}

const ok = (status: number) => () => new Response(null, { status });
const unreachable = () => {
  throw new TypeError("error sending request for url");
};

function fakeClient(onClose: () => void = () => {}): Deno.HttpClient {
  return {
    close: onClose,
    [Symbol.dispose]() {
      this.close();
    },
  };
}

// The tile keeps a consecutive-failure counter across calls. A reachable check
// clears it, so tests that care about the counter start from a known zero.
async function resetFailCounter() {
  const restore = stub(ok(200));
  try {
    await prodUptime.collect(ctx());
  } finally {
    restore();
  }
}

Deno.test("prod uptime: a fast 2xx -> good, headlined with the measured round trip", async () => {
  const restore = stub(ok(200), 137);
  try {
    const v = await prodUptime.collect(
      ctx({ PROD_URL: "https://prod.example.com/" }),
    );
    assertEquals(v.label, "production");
    assertEquals(v.status, "good");
    assertEquals(v.value, "137 ms");
    assertEquals(v.sub, "HTTP 200 · prod.example.com");
    assertEquals(v.href, "https://prod.example.com"); // the origin, not the checked URL
    assertEquals(v.hint, "open ↗");
  } finally {
    restore();
  }
});

Deno.test("prod uptime: a redirect is followed by nothing and still counts as reachable -> good", async () => {
  // redirect: "manual" means the 301 comes back as-is rather than being chased.
  const restore = stub(ok(301), 20);
  try {
    const v = await prodUptime.collect(
      ctx({ PROD_URL: "https://prod.example.com/" }),
    );
    assertEquals(v.status, "good");
    assertEquals(v.value, "20 ms");
    assertEquals(v.sub, "HTTP 301 · prod.example.com");
  } finally {
    restore();
  }
});

Deno.test("prod uptime: 5xx -> bad at once, and says erroring rather than a latency", async () => {
  // Reached and erroring is a real bad state, not a connectivity blip, so there
  // is no consecutive-failure grace period for it.
  const restore = stub(ok(503), 15);
  try {
    const v = await prodUptime.collect(
      ctx({ PROD_URL: "https://prod.example.com/" }),
    );
    assertEquals(v.status, "bad");
    assertEquals(v.value, "erroring");
    assertEquals(v.sub, "HTTP 503 · prod.example.com");
  } finally {
    restore();
  }
});

Deno.test("prod uptime: 4xx -> warn, not bad", async () => {
  const restore = stub(ok(404), 15);
  try {
    const v = await prodUptime.collect(
      ctx({ PROD_URL: "https://prod.example.com/" }),
    );
    assertEquals(v.status, "warn");
    assertEquals(v.value, "15 ms");
    assertEquals(v.sub, "HTTP 404 · prod.example.com");
  } finally {
    restore();
  }
});

Deno.test("prod uptime: a slow 200 -> warn on latency alone", async () => {
  const restore = stub(ok(200), 2501);
  try {
    const v = await prodUptime.collect(
      ctx({ PROD_URL: "https://prod.example.com/" }),
    );
    assertEquals(v.status, "warn");
    assertEquals(v.value, "2501 ms"); // still a latency, not "erroring" — it answered
  } finally {
    restore();
  }
  // 2500 is the edge and stays green.
  const restoreEdge = stub(ok(200), 2500);
  try {
    assertEquals(
      (await prodUptime.collect(ctx({ PROD_URL: "https://prod.example.com/" })))
        .status,
      "good",
    );
  } finally {
    restoreEdge();
  }
});

Deno.test("prod uptime: PROD_URL is the server; the tile checks its health and links to it", async () => {
  // The shell is a static site in a GCS bucket, so its index page answers 200 whether
  // or not the server behind it serves anything. The default asks the server itself.
  let asked: string | undefined;
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    asked = String(input);
    return Promise.resolve(new Response("", { status: 200 }));
  }) as typeof fetch;
  try {
    const v = await prodUptime.collect(ctx());
    assertEquals(asked, "https://estuary.saga-castor.ts.net/_health"); // health is what is checked
    assertEquals(v.href, "https://estuary.saga-castor.ts.net"); // the origin is what opens
    assertEquals(v.sub, "HTTP 200 · estuary.saga-castor.ts.net");
    // A PROD_URL carrying a path still means the server it points at.
    await prodUptime.collect(
      ctx({ PROD_URL: "https://example.test/some/page" }),
    );
    assertEquals(asked, "https://example.test/_health");
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("prod uptime: unset PROD_PROXY does not create or pass a Deno client", async () => {
  let created = 0;
  let seenInit: RequestInit | undefined;
  const restoreClient = setProdUptimeHttpClientFactoryForTest(() => {
    created++;
    return fakeClient();
  });
  const restore = stub((_url, init) => {
    seenInit = init;
    return new Response("ok", { status: 200 });
  });
  try {
    const v = await prodUptime.collect(
      ctx({ PROD_URL: "https://prod.example.com/" }),
    );
    assertEquals(v.status, "good");
    assertEquals(created, 0);
    assertEquals(seenInit === undefined ? false : "client" in seenInit, false);
  } finally {
    restore();
    restoreClient();
  }
});

Deno.test("prod uptime: socks5h PROD_PROXY creates a socks5 client, passes it to fetch, consumes the body, and closes it", async () => {
  let options: Parameters<typeof Deno.createHttpClient>[0] | undefined;
  let closed = false;
  let response: Response | undefined;
  const client = fakeClient(() => {
    closed = true;
    assertEquals(response?.bodyUsed, true);
  });
  const restoreClient = setProdUptimeHttpClientFactoryForTest((opts) => {
    options = opts;
    return client;
  });
  const restore = stub((_url, init) => {
    assertEquals(init?.client, client);
    response = new Response("healthy", { status: 200 });
    return response;
  });
  try {
    const v = await prodUptime.collect(ctx({
      PROD_URL: "https://prod.example.com/",
      PROD_PROXY: "socks5h://127.0.0.1:1055",
    }));
    assertEquals(v.status, "good");
    assertEquals(options, {
      proxy: { transport: "socks5", url: "socks5h://127.0.0.1:1055" },
    });
    assertEquals(closed, true);
  } finally {
    restore();
    restoreClient();
  }
});

Deno.test("prod uptime: HTTP PROD_PROXY creates an HTTP proxy client", async () => {
  let options: Parameters<typeof Deno.createHttpClient>[0] | undefined;
  let closed = false;
  const client = fakeClient(() => {
    closed = true;
  });
  const restoreClient = setProdUptimeHttpClientFactoryForTest((opts) => {
    options = opts;
    return client;
  });
  const restore = stub((_url, init) => {
    assertEquals(init?.client, client);
    return new Response("ok", { status: 200 });
  });
  try {
    const v = await prodUptime.collect(
      ctx({ PROD_PROXY: "http://proxy.example:8080" }),
    );
    assertEquals(v.status, "good");
    assertEquals(options, { proxy: { url: "http://proxy.example:8080" } });
    assertEquals(closed, true);
  } finally {
    restore();
    restoreClient();
  }
});

Deno.test("prod uptime: proxy client closes when fetch fails", async () => {
  await resetFailCounter();
  let closed = false;
  const client = fakeClient(() => {
    closed = true;
  });
  const restoreClient = setProdUptimeHttpClientFactoryForTest(() => client);
  const restore = stub(() => {
    throw new TypeError("proxy tunnel failed");
  });
  try {
    const v = await prodUptime.collect(
      ctx({ PROD_PROXY: "socks5://127.0.0.1:1055" }),
    );
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
    assertEquals(closed, true);
  } finally {
    restore();
    restoreClient();
  }
});

Deno.test("prod uptime: invalid or unsupported PROD_PROXY is unreachable without falling back direct", async () => {
  await resetFailCounter();
  let created = 0;
  let fetched = 0;
  const restoreClient = setProdUptimeHttpClientFactoryForTest(() => {
    created++;
    return fakeClient();
  });
  const restore = stub(() => {
    fetched++;
    return new Response("ok", { status: 200 });
  });
  try {
    const invalid = await prodUptime.collect(
      ctx({ PROD_PROXY: "not a url" }),
    );
    assertEquals(invalid.status, "unknown");
    assertEquals(invalid.value, "—");
    assertEquals(invalid.sub, "unreachable · estuary.saga-castor.ts.net");

    const unsupported = await prodUptime.collect(
      ctx({ PROD_PROXY: "ftp://proxy.example" }),
    );
    assertEquals(unsupported.status, "unknown");
    assertEquals(unsupported.value, "—");
    assertEquals(unsupported.sub, "unreachable · estuary.saga-castor.ts.net");
    assertEquals(created, 0);
    assertEquals(fetched, 0);
  } finally {
    restore();
    restoreClient();
  }
});

Deno.test("prod uptime: one unreachable check is gray 'can't tell', only three in a row is down", async () => {
  await resetFailCounter();
  const restore = stub(unreachable);
  try {
    // A single blip on the dashboard's side must not read as an outage.
    const first = await prodUptime.collect(
      ctx({ PROD_URL: "https://prod.example.com/" }),
    );
    assertEquals(first.status, "unknown");
    assertEquals(first.value, "—");
    assertEquals(first.sub, "unreachable · prod.example.com");
    assertEquals(first.href, "https://prod.example.com");
    assertEquals(first.hint, "open ↗");

    const second = await prodUptime.collect(
      ctx({ PROD_URL: "https://prod.example.com/" }),
    );
    assertEquals(second.status, "unknown");
    assertEquals(second.value, "—");

    // The third consecutive failure is a sustained run, and escalates.
    const third = await prodUptime.collect(
      ctx({ PROD_URL: "https://prod.example.com/" }),
    );
    assertEquals(third.status, "bad");
    assertEquals(third.value, "down");
    assertEquals(third.sub, "unreachable · prod.example.com");
  } finally {
    restore();
  }
});

Deno.test("prod uptime: a reachable check clears the run, so the next blip is gray again", async () => {
  // Two failures, then a success, then a failure: the counter restarts from the
  // success, so the last one is a first failure and stays gray.
  await resetFailCounter();
  const restoreFail = stub(unreachable);
  try {
    await prodUptime.collect(ctx());
    await prodUptime.collect(ctx());
  } finally {
    restoreFail();
  }

  const restoreOk = stub(ok(200), 8);
  try {
    assertEquals((await prodUptime.collect(ctx())).status, "good");
  } finally {
    restoreOk();
  }

  const restoreAgain = stub(unreachable);
  try {
    const v = await prodUptime.collect(ctx());
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
  } finally {
    restoreAgain();
  }
});

Deno.test("prod uptime: an unparseable PROD_URL throws rather than reporting green", async () => {
  // The URL is parsed outside the try, so a bad value surfaces to the collector,
  // which grays the tile. It never becomes a false "production is fine".
  const restore = stub(ok(200));
  try {
    await assertRejects(
      () => prodUptime.collect(ctx({ PROD_URL: "not a url" })),
      TypeError,
    );
  } finally {
    restore();
  }
});

Deno.test("prod uptime: identity and cadence", () => {
  assertEquals(prodUptime.id, "prod-uptime");
  assertEquals(prodUptime.intervalMs, 30_000);
});
