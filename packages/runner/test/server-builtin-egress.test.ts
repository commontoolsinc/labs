import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
} from "@std/assert";
import {
  createServerBuiltinEgressBroker,
  isAllowedExternalAddress,
  ServerBuiltinEgressError,
  type ServerBuiltinHttpTransport,
  type ServerBuiltinTransportRequest,
} from "../src/executor/server-builtin-egress.ts";

const response = (
  status = 200,
  headers?: HeadersInit,
  body?: BodyInit | null,
): Response => new Response(body ?? null, { status, headers });

const expectEgressError = async (
  promise: Promise<unknown>,
  code: ServerBuiltinEgressError["code"],
): Promise<ServerBuiltinEgressError> => {
  const error = await assertRejects(() => promise);
  assertInstanceOf(error, ServerBuiltinEgressError);
  assertEquals(error.code, code);
  return error;
};

const transportFrom = (
  request: (
    input: ServerBuiltinTransportRequest,
  ) => Response | Promise<Response>,
): ServerBuiltinHttpTransport => ({ request });

Deno.test("server builtin broker trusts relative requests to the configured serving origin", async () => {
  const requests: ServerBuiltinTransportRequest[] = [];
  const broker = createServerBuiltinEgressBroker({
    servingOrigin: "http://localhost:8000/some/internal/path",
    resolveHostAddresses: () => {
      throw new Error(
        "trusted serving-origin requests must not use public DNS policy",
      );
    },
    transport: transportFrom((request) => {
      requests.push(request);
      return response(200, { "content-type": "text/plain" }, "ok");
    }),
  });

  const result = await broker.fetch({ url: "/api/spaces/demo" });

  assertEquals(result.finalUrl.href, "http://localhost:8000/api/spaces/demo");
  assertEquals(await result.response.text(), "ok");
  assertEquals(requests.length, 1);
  assertEquals(requests[0].trustedServingOrigin, true);
  assertEquals(requests[0].resolvedAddresses, []);
});

Deno.test("relative requests retain serving-origin trust across an absolute same-origin redirect", async () => {
  const requests: ServerBuiltinTransportRequest[] = [];
  const broker = createServerBuiltinEgressBroker({
    servingOrigin: "http://127.0.0.1:8000",
    resolveHostAddresses: () => {
      throw new Error("same serving-origin redirect must remain trusted");
    },
    transport: transportFrom((request) => {
      requests.push(request);
      return requests.length === 1
        ? response(302, {
          location: "http://127.0.0.1:8000/api/final",
        })
        : response(200, undefined, "done");
    }),
  });

  const result = await broker.fetch({ url: "/api/start" });

  assertEquals(result.redirectCount, 1);
  assertEquals(result.finalUrl.href, "http://127.0.0.1:8000/api/final");
  assertEquals(
    requests.map((request) => request.trustedServingOrigin),
    [true, true],
  );
});

Deno.test("an origin-changing redirect is reclassified before connecting", async () => {
  let requests = 0;
  const broker = createServerBuiltinEgressBroker({
    servingOrigin: "https://fabric.example",
    resolveHostAddresses: (hostname) =>
      Promise.resolve(
        hostname === "private.example" ? ["10.23.4.5"] : ["93.184.216.34"],
      ),
    transport: transportFrom(() => {
      requests += 1;
      return response(302, { location: "http://private.example/secret" });
    }),
  });

  await expectEgressError(
    broker.fetch({ url: "/api/start" }),
    "blocked-destination",
  );
  assertEquals(requests, 1);
});

Deno.test("malformed redirects cancel their response body before failing", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const broker = createServerBuiltinEgressBroker({
    servingOrigin: "https://fabric.example",
    resolveHostAddresses: () => Promise.resolve(["93.184.216.34"]),
    transport: transportFrom(() =>
      response(302, { location: "http://[" }, body)
    ),
  });

  await expectEgressError(
    broker.fetch({ url: "https://example.com/start" }),
    "invalid-url",
  );
  assertEquals(cancelled, true);
});

Deno.test("absolute local, private, metadata, and disallowed-scheme targets are denied", async (t) => {
  const blocked = [
    "http://localhost/admin",
    "http://127.0.0.1/admin",
    "http://10.0.0.8/admin",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/admin",
    "http://metadata.google.internal/computeMetadata/v1",
    "//localhost/admin",
  ];
  for (const url of blocked) {
    await t.step(url, async () => {
      const broker = createServerBuiltinEgressBroker({
        servingOrigin: "https://fabric.example",
        resolveHostAddresses: (hostname) =>
          Promise.resolve(
            hostname === "metadata.google.internal"
              ? ["169.254.169.254"]
              : [hostname],
          ),
        transport: transportFrom(() => {
          throw new Error("blocked targets must not reach the transport");
        }),
      });
      await expectEgressError(
        broker.fetch({ url }),
        "blocked-destination",
      );
    });
  }

  for (
    const url of [
      "file:///etc/passwd",
      "data:text/plain,hello",
      "ftp://example.com/file",
    ]
  ) {
    await t.step(url, async () => {
      const broker = createServerBuiltinEgressBroker({
        servingOrigin: "https://fabric.example",
        resolveHostAddresses: () => Promise.resolve(["93.184.216.34"]),
        transport: transportFrom(() => {
          throw new Error("disallowed schemes must not reach the transport");
        }),
      });
      await expectEgressError(broker.fetch({ url }), "blocked-scheme");
    });
  }
});

Deno.test("DNS is screened again at every redirect hop against rebinding", async () => {
  let resolutions = 0;
  let requests = 0;
  const broker = createServerBuiltinEgressBroker({
    servingOrigin: "https://fabric.example",
    resolveHostAddresses: () => {
      resolutions += 1;
      return Promise.resolve(
        resolutions === 1 ? ["93.184.216.34"] : ["192.168.1.9"],
      );
    },
    transport: transportFrom((request) => {
      requests += 1;
      assertEquals(request.resolvedAddresses, ["93.184.216.34"]);
      return response(302, { location: "/next" });
    }),
  });

  await expectEgressError(
    broker.fetch({ url: "https://public.example/start" }),
    "blocked-destination",
  );
  assertEquals(resolutions, 2);
  assertEquals(requests, 1);
});

Deno.test("external transports receive the exact screened address set for connection pinning", async () => {
  const broker = createServerBuiltinEgressBroker({
    servingOrigin: "https://fabric.example",
    resolveHostAddresses: () =>
      Promise.resolve([
        "93.184.216.34",
        "2606:2800:220:1:248:1893:25c8:1946",
      ]),
    transport: transportFrom((request) => {
      assertEquals(request.trustedServingOrigin, false);
      assertEquals(request.resolvedAddresses, [
        "93.184.216.34",
        "2606:2800:220:1:248:1893:25c8:1946",
      ]);
      return response(200, undefined, "public");
    }),
  });

  const result = await broker.fetch({ url: "https://example.com/data" });
  assertEquals(await result.response.text(), "public");
});

Deno.test("address policy rejects non-global IPv4 and IPv6 ranges", () => {
  const blocked = [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.255.255.255",
    "169.254.1.1",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.0.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "100::1",
    "2001:db8::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "not-an-address",
  ];
  for (const address of blocked) {
    assertEquals(isAllowedExternalAddress(address), false, address);
  }
  for (
    const address of [
      "1.1.1.1",
      "93.184.216.34",
      "2606:4700:4700::1111",
    ]
  ) {
    assertEquals(isAllowedExternalAddress(address), true, address);
  }
});

Deno.test("broker normalizes methods and removes server-only request headers", async () => {
  let captured: ServerBuiltinTransportRequest | undefined;
  const broker = createServerBuiltinEgressBroker({
    servingOrigin: "https://fabric.example",
    resolveHostAddresses: () => Promise.resolve(["93.184.216.34"]),
    transport: transportFrom((request) => {
      captured = request;
      return response(204);
    }),
  });

  await broker.fetch({
    url: "https://example.com/submit",
    method: " post ",
    headers: {
      Connection: "upgrade",
      Cookie: "session=client-secret",
      Host: "internal.example",
      Origin: "https://spoofed.example",
      "Proxy-Authorization": "Basic secret",
      "Sec-Fetch-Site": "same-origin",
      "User-Agent": "client-controlled",
      "X-Pattern-Header": "kept",
    },
    body: "payload",
  });

  assert(captured !== undefined);
  assertEquals(captured.method, "POST");
  assertEquals(captured.redirect, "manual");
  assertEquals(captured.credentials, "omit");
  assertEquals(Object.fromEntries(captured.headers), {
    accept: "*/*",
    "user-agent": "Common-Fabric-Server-Builtin/1",
    "x-pattern-header": "kept",
  });
  assertEquals(captured.body, "payload");
});

Deno.test("cross-origin redirects strip authorization while retaining trusted custom headers", async () => {
  const requests: ServerBuiltinTransportRequest[] = [];
  const broker = createServerBuiltinEgressBroker({
    servingOrigin: "https://fabric.example",
    resolveHostAddresses: () => Promise.resolve(["93.184.216.34"]),
    transport: transportFrom((request) => {
      requests.push(request);
      return requests.length === 1
        ? response(302, { location: "https://public.example/final" })
        : response(200);
    }),
  });

  await broker.fetch({
    url: "/api/start",
    headers: {
      Authorization: "Bearer serving-origin-token",
      "X-Api-Key": "trusted-client-key",
    },
  });

  assertEquals(
    requests[0].headers.get("authorization"),
    "Bearer serving-origin-token",
  );
  assertEquals(requests[1].headers.get("authorization"), null);
  assertEquals(requests[1].headers.get("x-api-key"), "trusted-client-key");
});

Deno.test("broker rejects declared and streamed responses above the byte limit", async (t) => {
  await t.step("declared content length", async () => {
    const broker = createServerBuiltinEgressBroker({
      servingOrigin: "https://fabric.example",
      limits: { maxResponseBytes: 5 },
      resolveHostAddresses: () => Promise.resolve(["93.184.216.34"]),
      transport: transportFrom(() =>
        response(200, { "content-length": "6" }, "ignored")
      ),
    });
    await expectEgressError(
      broker.fetch({ url: "https://example.com/large" }),
      "response-too-large",
    );
  });

  await t.step("streamed body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const broker = createServerBuiltinEgressBroker({
      servingOrigin: "https://fabric.example",
      limits: { maxResponseBytes: 5 },
      resolveHostAddresses: () => Promise.resolve(["93.184.216.34"]),
      transport: transportFrom(() => response(200, undefined, body)),
    });
    await expectEgressError(
      broker.fetch({ url: "https://example.com/large" }),
      "response-too-large",
    );
    assertEquals(cancelled, true);
  });
});

Deno.test("broker timeout is deterministic through an injected scheduler", async () => {
  let fireTimeout: (() => void) | undefined;
  const broker = createServerBuiltinEgressBroker({
    servingOrigin: "https://fabric.example",
    limits: { timeoutMs: 1234 },
    resolveHostAddresses: () => Promise.resolve(["93.184.216.34"]),
    scheduleTimeout(callback, milliseconds) {
      assertEquals(milliseconds, 1234);
      fireTimeout = callback;
      return () => {};
    },
    transport: transportFrom(() => {
      throw new Error("timeout before transport must prevent network access");
    }),
  });

  const pending = broker.fetch({ url: "https://example.com/slow" });
  assert(fireTimeout !== undefined);
  fireTimeout();
  await expectEgressError(pending, "request-timeout");
});

Deno.test("broker bounds redirects and response headers", async (t) => {
  await t.step("redirects", async () => {
    let requests = 0;
    const broker = createServerBuiltinEgressBroker({
      servingOrigin: "https://fabric.example",
      limits: { maxRedirects: 1 },
      resolveHostAddresses: () => Promise.resolve(["93.184.216.34"]),
      transport: transportFrom(() => {
        requests += 1;
        return response(302, { location: `/hop-${requests}` });
      }),
    });
    await expectEgressError(
      broker.fetch({ url: "https://example.com/start" }),
      "too-many-redirects",
    );
    assertEquals(requests, 2);
  });

  await t.step("response headers", async () => {
    const broker = createServerBuiltinEgressBroker({
      servingOrigin: "https://fabric.example",
      limits: { maxResponseHeaderBytes: 8 },
      resolveHostAddresses: () => Promise.resolve(["93.184.216.34"]),
      transport: transportFrom(() => response(200, { "x-long": "123456789" })),
    });
    await expectEgressError(
      broker.fetch({ url: "https://example.com/headers" }),
      "response-headers-too-large",
    );
  });
});
