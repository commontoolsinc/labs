// prod-uptime tests use canned HTTP, DNS and SOCKS5 replies. No test reaches
// the network.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import type { Ctx, TileView } from "../types.ts";
import type { ProxyStream } from "./prod-uptime.ts";
import {
  prodUptime,
  setProdUptimeDnsResolverForTest,
  setProdUptimeHttpClientFactoryForTest,
  setProdUptimeProxyStreamOpenerForTest,
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
const PUBLIC_HOSTS = DEFAULT_HOSTS.filter((host) => !host.endsWith(".ts.net"));

// What a fake SOCKS5 proxy was asked for, so a test can check the exchange.
interface Socks5Log {
  opened: string[];
  commands: number[];
  addressTypes: number[];
  connects: string[];
  closed: number;
}

function socks5Log(): Socks5Log {
  return {
    opened: [],
    commands: [],
    addressTypes: [],
    connects: [],
    closed: 0,
  };
}

// A proxy that greets with "no authentication" and answers every CONNECT with
// one reply code.
function fakeSocks5(reply: number, log: Socks5Log) {
  return (options: Deno.ConnectOptions): Promise<ProxyStream> => {
    log.opened.push(`${options.hostname}:${options.port}`);
    const pending: number[] = [];
    return Promise.resolve({
      write(bytes: Uint8Array) {
        if (bytes.length === 3) {
          pending.push(5, 0);
        } else {
          const nameLength = bytes[4];
          const name = new TextDecoder().decode(
            bytes.subarray(5, 5 + nameLength),
          );
          const target = (bytes[5 + nameLength] << 8) | bytes[6 + nameLength];
          log.commands.push(bytes[1]);
          log.addressTypes.push(bytes[3]);
          log.connects.push(`${name}:${target}`);
          pending.push(5, reply, 0, 1, 0, 0, 0, 0, 0, 0);
        }
        return Promise.resolve(bytes.length);
      },
      read(buffer: Uint8Array) {
        if (pending.length === 0) return Promise.resolve(null);
        const count = Math.min(buffer.length, pending.length);
        buffer.set(pending.splice(0, count));
        return Promise.resolve(count);
      },
      close() {
        log.closed++;
      },
    });
  };
}

function ctx(env: Record<string, string> = {}): Ctx {
  return {
    runs: () => Promise.resolve([]),
    runsFor: () => Promise.resolve([]),
    env: (key) => env[key],
  };
}

// Building a real proxied client asks for network permission the unit tests do
// not grant, so tests that set PROD_PROXY hand back a stand-in.
function stubProxyClient(): () => void {
  return setProdUptimeHttpClientFactoryForTest(() => fakeClient());
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
  opener = fakeSocks5(0, socks5Log()),
) {
  const restoreOpener = setProdUptimeProxyStreamOpenerForTest(opener);
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
    restoreOpener();
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

Deno.test("prod uptime: HTTP and DNS failures headline DNS down", async () => {
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
  const log = socks5Log();
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
  }, undefined, fakeSocks5(0, log));
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
    assertEquals(log.opened, ["127.0.0.1:1055"]);
    assertEquals(log.connects, ["bastion.saga-castor.ts.net:22"]);
    assertEquals(log.closed, 1);
  } finally {
    restore();
    restoreClient();
  }
});

Deno.test("prod uptime: a proxy replaces the local resolver for tailnet names", async () => {
  const resolved: string[] = [];
  const log = socks5Log();
  const restoreClient = stubProxyClient();
  const restore = stub(undefined, (hostname) => {
    resolved.push(hostname);
    return ["34.54.221.196"];
  }, fakeSocks5(0, log));
  try {
    const view = await prodUptime.collect(
      ctx({ PROD_PROXY: "socks5h://127.0.0.1:1055" }),
    );
    assertEquals([...new Set(resolved)].sort(), [...PUBLIC_HOSTS].sort());
    assertEquals(log.commands, [1]);
    assertEquals(log.addressTypes, [3]);
    assertEquals(log.connects, ["bastion.saga-castor.ts.net:22"]);
    assertEquals(view.status, "good");
    assertEquals(view.value, "7/7 hosts up");
    assert(!(view.extra ?? "").includes("bastion"));
  } finally {
    restore();
    restoreClient();
  }
});

Deno.test("prod uptime: a tailnet host the proxy cannot reach is a red exception", async () => {
  for (const reply of [1, 2, 4, 5]) {
    const restoreClient = stubProxyClient();
    const restore = stub(undefined, undefined, fakeSocks5(reply, socks5Log()));
    try {
      const view = await prodUptime.collect(
        ctx({ PROD_PROXY: "socks5h://127.0.0.1:1055" }),
      );
      assertEquals(view.status, "bad");
      assertEquals(view.value, "unreachable");
      assertStringIncludes(view.extra ?? "", "bastion");
      assertStringIncludes(view.extra ?? "", "unreachable");
      assert(!(view.extra ?? "").includes("DNS"));
    } finally {
      restore();
      restoreClient();
    }
  }
});

Deno.test("prod uptime: a proxy that will not talk leaves the host unreachable", async () => {
  for (
    const opener of [
      () => Promise.reject(new Deno.errors.ConnectionRefused("refused")),
      // A proxy that hangs up before the greeting.
      () =>
        Promise.resolve<ProxyStream>({
          read: () => Promise.resolve(null),
          write: (bytes: Uint8Array) => Promise.resolve(bytes.length),
          close: () => {},
        }),
      // A proxy that demands a login this client cannot offer.
      () => {
        const pending = [5, 2];
        return Promise.resolve<ProxyStream>({
          read: (buffer: Uint8Array) => {
            const count = Math.min(buffer.length, pending.length);
            buffer.set(pending.splice(0, count));
            return Promise.resolve(count);
          },
          write: (bytes: Uint8Array) => Promise.resolve(bytes.length),
          close: () => {},
        });
      },
    ]
  ) {
    const restoreClient = stubProxyClient();
    const restore = stub(undefined, undefined, opener);
    try {
      const view = await prodUptime.collect(
        ctx({ PROD_PROXY: "socks5h://127.0.0.1:1055" }),
      );
      assertEquals(view.status, "bad");
      assertEquals(view.value, "unreachable");
      assertStringIncludes(view.extra ?? "", "bastion");
    } finally {
      restore();
      restoreClient();
    }
  }
});

Deno.test("prod uptime: the SOCKS5 exchange survives short reads and writes", async () => {
  const connects: string[] = [];
  const restoreClient = stubProxyClient();
  // A proxy that accepts and returns exactly one byte at a time.
  const restore = stub(undefined, undefined, () => {
    const pending: number[] = [];
    const received: number[] = [];
    let greeted = false;
    return Promise.resolve<ProxyStream>({
      write(bytes: Uint8Array) {
        received.push(bytes[0]);
        if (!greeted) {
          if (received.length === 3) {
            pending.push(5, 0);
            received.length = 0;
            greeted = true;
          }
        } else if (
          received.length >= 5 && received.length === 7 + received[4]
        ) {
          const nameLength = received[4];
          const name = new TextDecoder().decode(
            new Uint8Array(received.slice(5, 5 + nameLength)),
          );
          const port = (received[5 + nameLength] << 8) |
            received[6 + nameLength];
          connects.push(`${name}:${port}`);
          pending.push(5, 0, 0, 1, 0, 0, 0, 0, 0, 0);
        }
        return Promise.resolve(1);
      },
      read(buffer: Uint8Array) {
        const next = pending.shift();
        if (next === undefined) return Promise.resolve(null);
        buffer[0] = next;
        return Promise.resolve(1);
      },
      close() {},
    });
  });
  try {
    const view = await prodUptime.collect(
      ctx({ PROD_PROXY: "socks5h://127.0.0.1:1055" }),
    );
    assertEquals(connects, ["bastion.saga-castor.ts.net:22"]);
    assertEquals(view.status, "good");
    assertEquals(view.value, "7/7 hosts up");
  } finally {
    restore();
    restoreClient();
  }
});

Deno.test("prod uptime: a probed host is revisited hourly, not every collection", async () => {
  const log = socks5Log();
  const restoreClient = stubProxyClient();
  const restore = stub(undefined, undefined, fakeSocks5(0, log));
  const realNow = Date.now;
  let clock = 0;
  Date.now = () => clock;
  try {
    const proxied = ctx({ PROD_PROXY: "socks5h://127.0.0.1:1055" });
    await prodUptime.collect(proxied);
    assertEquals(log.connects.length, 1);

    await prodUptime.collect(proxied);
    clock = 3_599_999;
    await prodUptime.collect(proxied);
    assertEquals(log.connects.length, 1);

    clock = 3_600_000;
    const view = await prodUptime.collect(proxied);
    assertEquals(log.connects.length, 2);
    assertEquals(view.status, "good");
  } finally {
    Date.now = realNow;
    restore();
    restoreClient();
  }
});

Deno.test("prod uptime: a remembered probe keeps its verdict between visits", async () => {
  const log = socks5Log();
  const restoreClient = stubProxyClient();
  const restore = stub(undefined, undefined, fakeSocks5(1, log));
  try {
    const proxied = ctx({ PROD_PROXY: "socks5h://127.0.0.1:1055" });
    const first = await prodUptime.collect(proxied);
    const second = await prodUptime.collect(proxied);
    assertEquals(log.connects.length, 1);
    assertEquals(second.status, "bad");
    assertEquals(second.value, "unreachable");
    assertEquals(second.extra, first.extra);
  } finally {
    restore();
    restoreClient();
  }
});

Deno.test("prod uptime: a name too long for the protocol is unreachable", async () => {
  const log = socks5Log();
  const restoreClient = stubProxyClient();
  const restore = stub(undefined, undefined, fakeSocks5(0, log));
  try {
    const view = await prodUptime.collect(ctx({
      PROD_PROXY: "socks5h://127.0.0.1:1055",
      BASTION_HOST: `${"jump.".repeat(52)}saga-castor.ts.net`,
    }));
    assertEquals(log.opened, []);
    assertEquals(view.status, "bad");
    assertEquals(view.value, "unreachable");
    assertStringIncludes(view.extra ?? "", "bastion");
  } finally {
    restore();
    restoreClient();
  }
});

Deno.test("prod uptime: a health URL carrying a port keeps it", async () => {
  const fetched: string[] = [];
  const restore = stub((url) => {
    fetched.push(url);
    return new Response(null, { status: 200 });
  });
  try {
    const view = await prodUptime.collect(ctx({
      ESTUARY_URL: "https://prod.example.test:8443",
      RAPIDS_URL: "http://stage.example.test",
    }));
    assertEquals(fetched.sort(), [
      "http://stage.example.test/_health",
      "https://prod.example.test:8443/_health",
    ]);
    assertEquals(view.status, "good");
  } finally {
    restore();
  }
});

Deno.test("prod uptime: BASTION_HOST names the port the proxy connects to", async () => {
  const log = socks5Log();
  const restoreClient = stubProxyClient();
  const restore = stub(undefined, undefined, fakeSocks5(0, log));
  try {
    const view = await prodUptime.collect(ctx({
      PROD_PROXY: "socks5://proxy.example.test",
      BASTION_HOST: "ssh://jump.saga-castor.ts.net:2222",
    }));
    assertEquals(log.opened, ["proxy.example.test:1080"]);
    assertEquals(log.connects, ["jump.saga-castor.ts.net:2222"]);
    assertEquals(view.status, "good");
  } finally {
    restore();
    restoreClient();
  }
});

Deno.test("prod uptime: an HTTP proxy leaves a tailnet-only host gray", async () => {
  const log = socks5Log();
  const restoreClient = stubProxyClient();
  const restore = stub(undefined, undefined, fakeSocks5(0, log));
  try {
    const view = await prodUptime.collect(
      ctx({ PROD_PROXY: "http://127.0.0.1:8080" }),
    );
    assertEquals(log.opened, []);
    assertEquals(view.status, "unknown");
    assertEquals(view.value, "no proxy route");
    assertStringIncludes(view.extra ?? "", "bastion");
    assertStringIncludes(view.extra ?? "", "no proxy route");
  } finally {
    restore();
    restoreClient();
  }
});

Deno.test("prod uptime: accepted proxy schemes configure one shared client", async () => {
  for (
    const [proxy, expected, expectedStatus] of [
      [
        "http://127.0.0.1:8080",
        { proxy: { url: "http://127.0.0.1:8080" } },
        "unknown",
      ],
      [
        "https://127.0.0.1:8080",
        { proxy: { url: "https://127.0.0.1:8080" } },
        "unknown",
      ],
      [
        "socks5://127.0.0.1:1055",
        {
          proxy: {
            transport: "socks5" as const,
            url: "socks5://127.0.0.1:1055",
          },
        },
        "good",
      ],
    ] as const
  ) {
    let options: Parameters<typeof Deno.createHttpClient>[0] | undefined;
    let closed = 0;
    const client = fakeClient(() => closed++);
    const restoreClient = setProdUptimeHttpClientFactoryForTest((value) => {
      options = value;
      return client;
    });
    const restore = stub((_url, init) => {
      assertEquals(init?.client, client);
      return new Response(null, { status: 200 });
    });
    try {
      const view = await prodUptime.collect(ctx({ PROD_PROXY: proxy }));
      assertEquals(view.status, expectedStatus);
      assertEquals(options, expected);
      assertEquals(closed, 1);
    } finally {
      restore();
      restoreClient();
    }
  }
});

Deno.test("prod uptime: malformed and unsafe proxies fail closed", async () => {
  for (
    const proxy of [
      "not a url",
      "http://user@127.0.0.1:8080",
      "http://:password@127.0.0.1:8080",
      "ftp://127.0.0.1:2121",
    ]
  ) {
    let fetched = 0;
    const restore = stub(() => {
      fetched++;
      return new Response(null, { status: 200 });
    });
    try {
      const view = await prodUptime.collect(ctx({ PROD_PROXY: proxy }));
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
