import { assertEquals, assertThrows } from "@std/assert";
import {
  authorizeDefaultServerBuiltinRequest,
  createDefaultServerBuiltinBroker,
} from "../src/executor/server-builtin-transport.ts";
import { ServerBuiltinUnservedError } from "../src/executor/server-builtin-channel.ts";

Deno.test("default builtin transport reserves ambient fetch for raw-relative serving-origin calls", async () => {
  const ambient: string[] = [];
  const pinned: Array<{ url: string; address: string }> = [];
  const broker = createDefaultServerBuiltinBroker({
    servingOrigin: new URL("http://127.0.0.1:8787/"),
    fetchImpl: (input) => {
      ambient.push(input.toString());
      return Promise.resolve(new Response("local"));
    },
    resolveDns: ((hostname: string, recordType: string) =>
      Promise.resolve(
        hostname === "public.example" && recordType === "A"
          ? ["93.184.216.34"]
          : [],
      )) as typeof Deno.resolveDns,
    pinnedFetch: ((url: URL, address: string) => {
      pinned.push({ url: url.href, address });
      return Promise.resolve(new Response("external"));
    }) as never,
  });

  const local = await broker.fetch({ url: "/api/local" });
  assertEquals(await local.response.text(), "local");
  assertEquals(ambient, ["http://127.0.0.1:8787/api/local"]);
  assertEquals(pinned, []);

  const external = await broker.fetch({
    url: "https://public.example/value",
  });
  assertEquals(await external.response.text(), "external");
  assertEquals(pinned, [{
    url: "https://public.example/value",
    address: "93.184.216.34",
  }]);
});

Deno.test("default builtin authorization fails closed for protected first-party routes", () => {
  const error = assertThrows(
    () =>
      authorizeDefaultServerBuiltinRequest({
        builtinId: "fetchJson",
        claim: {} as never,
        actingIdentity: { lane: "space", onBehalfOf: "did:key:z6Mk-user" },
        fetch: {
          url: "/api/agent-tools/web-read",
          method: "POST",
        },
      }, {
        space: "did:key:z6Mk-builtin-auth",
        branch: "",
        leaseGeneration: 1,
        onBehalfOf: "did:key:z6Mk-user",
        servingOrigin: new URL("https://toolshed.example/"),
      }),
    ServerBuiltinUnservedError,
    "delegated user signing",
  );
  assertEquals(
    (error as ServerBuiltinUnservedError).diagnosticCode,
    "server-builtin-authorization-denied",
  );
});

Deno.test("default builtin authorization normalizes methods before classifying protected routes", () => {
  assertThrows(
    () =>
      authorizeDefaultServerBuiltinRequest({
        builtinId: "fetchJson",
        claim: {} as never,
        actingIdentity: { lane: "space", onBehalfOf: "did:key:z6Mk-user" },
        fetch: {
          url: "/api/agent-tools/web-read",
          method: " POST ",
        },
      }, {
        space: "did:key:z6Mk-builtin-auth",
        branch: "",
        leaseGeneration: 1,
        onBehalfOf: "did:key:z6Mk-user",
        servingOrigin: new URL("https://toolshed.example/"),
      }),
    Error,
    "delegated user signing",
  );
});

Deno.test("default builtin authorization defers malformed URLs to the egress classifier", () => {
  authorizeDefaultServerBuiltinRequest({
    builtinId: "fetchJson",
    claim: {} as never,
    actingIdentity: { lane: "space", onBehalfOf: "did:key:z6Mk-user" },
    fetch: {
      url: "http://[",
      method: "GET",
    },
  }, {
    space: "did:key:z6Mk-builtin-auth",
    branch: "",
    leaseGeneration: 1,
    onBehalfOf: "did:key:z6Mk-user",
    servingOrigin: new URL("https://toolshed.example/"),
  });
});
