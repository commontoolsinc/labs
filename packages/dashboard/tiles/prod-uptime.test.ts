// prod-uptime tests use canned HTTP and DNS replies. No test reaches the
// network.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import type { Ctx, TileView } from "../types.ts";
import {
  prodUptime,
  setProdUptimeDnsResolverForTest,
  setProdUptimeHttpClientFactoryForTest,
} from "./prod-uptime.ts";

type ProxyFetchInit = RequestInit & { client?: Deno.HttpClient };
type DnsReply = readonly string[] | Error;

const DEFAULT_HOSTS = [
  "estuary.saga-castor.ts.net",
  "rapids.saga-castor.ts.net",
  "bastion.saga-castor.ts.net",
  "production.commontools.dev",
  "staging.commontools.dev",
  "llm.stage.commontools.dev",
  "sandbox.stage.commontools.dev",
];

function ctx(env: Record<string, string> = {}): Ctx {
  return {
    runs: () => Promise.resolve([]),
    runsFor: () => Promise.resolve([]),
    env: (key) => env[key],
  };
}

function fakeClient(onClose: () => void = () => {}): Deno.HttpClient {
  return {
    close: onClose,
    [Symbol.dispose]() {
      this.close();
    },
  };
}

function stub(
  http: (
    url: string,
    init: ProxyFetchInit | undefined,
  ) => Response = () => new Response(null, { status: 200 }),
  dns: (hostname: string, recordType: "A" | "AAAA") => DnsReply = () => [
    "100.64.0.1",
  ],
) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    try {
      return Promise.resolve(http(String(input), init));
    } catch (error) {
      return Promise.reject(error);
    }
  }) as typeof fetch;
  const restoreDns = setProdUptimeDnsResolverForTest(
    (hostname, recordType) => {
      const reply = dns(hostname, recordType);
      return reply instanceof Error
        ? Promise.reject(reply)
        : Promise.resolve(reply);
    },
  );
  return () => {
    globalThis.fetch = realFetch;
    restoreDns();
  };
}

async function withLatency(ms: number): Promise<TileView> {
  const realNow = Date.now;
  let calls = 0;
  Date.now = () => calls++ < 2 ? 0 : ms;
  const restore = stub();
  try {
    return await prodUptime.collect(ctx());
  } finally {
    Date.now = realNow;
    restore();
  }
}

Deno.test("prod uptime: healthy servers keep pings while DNS-only hosts disappear", async () => {
  const fetched: string[] = [];
  const resolved: string[] = [];
  const restore = stub(
    (url) => {
      fetched.push(url);
      return new Response(null, { status: 200 });
    },
    (hostname, recordType) => {
      resolved.push(`${hostname} ${recordType}`);
      return ["100.64.0.1"];
    },
  );
  try {
    const view = await prodUptime.collect(ctx());
    assertEquals(fetched.sort(), [
      "https://estuary.saga-castor.ts.net/_health",
      "https://rapids.saga-castor.ts.net/_health",
    ]);
    assertEquals(
      resolved.sort(),
      DEFAULT_HOSTS.flatMap((hostname) => [
        `${hostname} A`,
        `${hostname} AAAA`,
      ]).sort(),
    );
    assertEquals(view.label, "production");
    assertEquals(view.status, "good");
    assertEquals(view.value, "7/7 hosts up");
    assertEquals(view.sub, undefined);
    assertStringIncludes(view.extra ?? "", "estuary");
    assertStringIncludes(view.extra ?? "", "rapids");
    assertEquals((view.extra ?? "").match(/\d+ ms/g)?.length, 2);
    assert(!(view.extra ?? "").includes("bastion"));
    assert(!(view.extra ?? "").includes("prod shell"));
    assert(!(view.extra ?? "").includes("DNS yes"));
  } finally {
    restore();
  }
});

Deno.test("prod uptime: every non-200 health response is a red exception", async () => {
  for (const responseStatus of [301, 404, 503]) {
    const restore = stub((url) =>
      new Response(null, {
        status: url.includes("rapids") ? responseStatus : 200,
      })
    );
    try {
      const view = await prodUptime.collect(ctx());
      assertEquals(view.status, "bad");
      assertEquals(view.value, `HTTP ${responseStatus}`);
      assert(!(view.extra ?? "").includes("estuary"));
      assertStringIncludes(view.extra ?? "", "rapids");
      assertStringIncludes(view.extra ?? "", `HTTP ${responseStatus}`);
      assert(!(view.extra ?? "").includes("HTTP 200"));
      assert(!(view.extra ?? "").includes("DNS yes"));
    } finally {
      restore();
    }
  }
});

Deno.test("prod uptime: latency is orange above 275 ms and red above 500 ms", async () => {
  const prompt = await withLatency(275);
  assertEquals(prompt.status, "good");
  assertEquals(prompt.value, "7/7 hosts up");
  assertStringIncludes(prompt.extra ?? "", "275 ms");

  const slow = await withLatency(276);
  assertEquals(slow.status, "warn");
  assertEquals(slow.value, "276 ms");
  assertStringIncludes(slow.extra ?? "", "276 ms");

  const edge = await withLatency(500);
  assertEquals(edge.status, "warn");
  assertEquals(edge.value, "500 ms");
  assertStringIncludes(edge.extra ?? "", "500 ms");

  const bad = await withLatency(501);
  assertEquals(bad.status, "bad");
  assertEquals(bad.value, "501 ms");
  assertStringIncludes(bad.extra ?? "", "501 ms");
});

Deno.test("prod uptime: a missing hostname is a red DNS down exception", async () => {
  const restore = stub(
    undefined,
    (hostname) =>
      hostname.startsWith("bastion")
        ? new Deno.errors.NotFound("no record")
        : ["100.64.0.1"],
  );
  try {
    const view = await prodUptime.collect(ctx());
    assertEquals(view.status, "bad");
    assertEquals(view.value, "DNS down");
    assertStringIncludes(view.extra ?? "", "bastion");
    assertStringIncludes(view.extra ?? "", "DNS down");
    assert(!(view.extra ?? "").includes("estuary"));
    assert(!(view.extra ?? "").includes("rapids"));
    assert(!(view.extra ?? "").includes("DNS yes"));
  } finally {
    restore();
  }
});

Deno.test("prod uptime: one host with HTTP and DNS failures counts once", async () => {
  const restore = stub(
    (url) => new Response(null, { status: url.includes("rapids") ? 503 : 200 }),
    (hostname) =>
      hostname.startsWith("rapids")
        ? new Deno.errors.NotFound("no record")
        : ["100.64.0.1"],
  );
  try {
    const view = await prodUptime.collect(ctx());
    assertEquals(view.status, "bad");
    assertEquals(view.value, "DNS down");
    assert(!(view.extra ?? "").includes("estuary"));
    assertStringIncludes(view.extra ?? "", "rapids");
    assertStringIncludes(view.extra ?? "", "HTTP 503");
    assertStringIncludes(view.extra ?? "", "DNS down");
  } finally {
    restore();
  }
});

Deno.test("prod uptime: red outranks orange and HTTP outranks latency", async () => {
  const realNow = Date.now;
  const readings = [0, 0, 501, 300];
  Date.now = () => readings.shift() ?? 0;
  const restore = stub(
    (url) => new Response(null, { status: url.includes("rapids") ? 502 : 200 }),
    (hostname) =>
      hostname.startsWith("bastion")
        ? new Deno.errors.PermissionDenied("resolver unavailable")
        : ["100.64.0.1"],
  );
  try {
    const view = await prodUptime.collect(ctx());
    assertEquals(view.status, "bad");
    assertEquals(view.value, "HTTP 502");
    assertStringIncludes(view.extra ?? "", "501 ms");
    assertStringIncludes(view.extra ?? "", "HTTP 502");
    assertStringIncludes(view.extra ?? "", "DNS unknown");
  } finally {
    Date.now = realNow;
    restore();
  }
});

Deno.test("prod uptime: resolver failures are orange DNS unknown exceptions", async () => {
  const restore = stub(
    undefined,
    (hostname) =>
      hostname.startsWith("rapids")
        ? new Deno.errors.PermissionDenied("resolver unavailable")
        : ["100.64.0.1"],
  );
  try {
    const view = await prodUptime.collect(ctx());
    assertEquals(view.status, "warn");
    assertEquals(view.value, "DNS unknown");
    assertStringIncludes(view.extra ?? "", "rapids");
    assertStringIncludes(view.extra ?? "", "DNS unknown");
  } finally {
    restore();
  }
});

Deno.test("prod uptime: either an A or AAAA answer confirms DNS", async () => {
  const restore = stub(
    undefined,
    (_hostname, recordType) =>
      recordType === "A"
        ? ["100.64.0.1"]
        : new Deno.errors.NotFound("no IPv6 record"),
  );
  try {
    const view = await prodUptime.collect(ctx());
    assertEquals(view.status, "good");
    assertEquals(view.value, "7/7 hosts up");
    assertStringIncludes(view.extra ?? "", "estuary");
    assertStringIncludes(view.extra ?? "", "rapids");
  } finally {
    restore();
  }
});

Deno.test("prod uptime: explicit server URLs and bastion host replace their defaults", async () => {
  const fetched: string[] = [];
  const resolved: string[] = [];
  const restore = stub(
    (url) => {
      fetched.push(url);
      return new Response(null, { status: 200 });
    },
    (hostname) => {
      resolved.push(hostname);
      return ["192.0.2.1"];
    },
  );
  try {
    const view = await prodUptime.collect(ctx({
      ESTUARY_URL: "https://prod.example.test/some/path",
      PROD_URL: "https://ignored.example.test",
      RAPIDS_URL: "https://stage.example.test/base",
      BASTION_HOST: "ssh://jump.example.test:22",
    }));
    assertEquals(fetched.sort(), [
      "https://prod.example.test/_health",
      "https://stage.example.test/_health",
    ]);
    assertEquals(resolved.includes("prod.example.test"), true);
    assertEquals(resolved.includes("stage.example.test"), true);
    assertEquals(resolved.includes("jump.example.test"), true);
    assertEquals(resolved.includes("ignored.example.test"), false);
    assertEquals(view.value, "7/7 hosts up");
    assertStringIncludes(view.extra ?? "", "estuary");
    assertStringIncludes(view.extra ?? "", "rapids");
  } finally {
    restore();
  }
});

Deno.test("prod uptime: PROD_URL remains an estuary URL alias", async () => {
  const fetched: string[] = [];
  const restore = stub((url) => {
    fetched.push(url);
    return new Response(null, { status: 200 });
  });
  try {
    await prodUptime.collect(ctx({ PROD_URL: "https://legacy.example.test" }));
    assertEquals(
      fetched.includes("https://legacy.example.test/_health"),
      true,
    );
  } finally {
    restore();
  }
});

Deno.test("prod uptime: one proxy client serves both health checks and closes after them", async () => {
  let options: Parameters<typeof Deno.createHttpClient>[0] | undefined;
  let closed = 0;
  let cancelled = 0;
  const client = fakeClient(() => closed++);
  const restoreClient = setProdUptimeHttpClientFactoryForTest((value) => {
    options = value;
    return client;
  });
  let fetched = 0;
  const restore = stub((_url, init) => {
    fetched++;
    assertEquals(init?.client, client);
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled++;
        },
      }),
      { status: 200 },
    );
  });
  try {
    const view = await prodUptime.collect(
      ctx({ PROD_PROXY: "socks5h://127.0.0.1:1055" }),
    );
    assertEquals(view.status, "good");
    assertEquals(view.value, "7/7 hosts up");
    assertStringIncludes(view.extra ?? "", "estuary");
    assertStringIncludes(view.extra ?? "", "rapids");
    assertEquals(options, {
      proxy: { transport: "socks5", url: "socks5h://127.0.0.1:1055" },
    });
    assertEquals(fetched, 2);
    assertEquals(cancelled, 2);
    assertEquals(closed, 1);
  } finally {
    restore();
    restoreClient();
  }
});

Deno.test("prod uptime: an invalid proxy leaves two orange exceptions", async () => {
  let fetched = 0;
  const restore = stub(() => {
    fetched++;
    return new Response(null, { status: 200 });
  });
  try {
    const view = await prodUptime.collect(ctx({ PROD_PROXY: "not a url" }));
    assertEquals(fetched, 0);
    assertEquals(view.status, "warn");
    assertEquals(view.value, "invalid proxy");
    assertStringIncludes(view.extra ?? "", "estuary");
    assertStringIncludes(view.extra ?? "", "rapids");
    assertStringIncludes(view.extra ?? "", "invalid proxy");
    assert(!(view.extra ?? "").includes("bastion"));
  } finally {
    restore();
  }
});

Deno.test("prod uptime: an unreachable health check is orange without confirmation", async () => {
  const restore = stub((url) => {
    if (url.includes("rapids")) throw new TypeError("unreachable");
    return new Response(null, { status: 200 });
  });
  try {
    const view = await prodUptime.collect(ctx());
    assertEquals(view.status, "warn");
    assertEquals(view.value, "unreachable");
    assertStringIncludes(view.extra ?? "", "estuary");
    assertStringIncludes(view.extra ?? "", "rapids");
    assertStringIncludes(view.extra ?? "", "unreachable");
  } finally {
    restore();
  }
});

Deno.test("prod uptime: body cleanup cannot hide a prompt HTTP 200", async () => {
  const restore = stub(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          throw new Error("cleanup failed");
        },
      }),
      { status: 200 },
    )
  );
  try {
    const view = await prodUptime.collect(ctx());
    assertEquals(view.status, "good");
    assertEquals(view.value, "7/7 hosts up");
    assertStringIncludes(view.extra ?? "", "estuary");
    assertStringIncludes(view.extra ?? "", "rapids");
  } finally {
    restore();
  }
});

Deno.test("prod uptime: an unparseable configured URL rejects the collection", async () => {
  const restore = stub();
  try {
    await assertRejects(
      () => prodUptime.collect(ctx({ ESTUARY_URL: "not a url" })),
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
