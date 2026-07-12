import { assertEquals, assertRejects } from "@std/assert";
import type { ExecutionClaim } from "@commonfabric/memory/v2";
import {
  createServerBuiltinBrokerClient,
  createServerBuiltinBrokerHost,
} from "../src/executor/server-builtin-channel.ts";
import type { ServerBuiltinFetchBroker } from "../src/executor/server-builtin-egress.ts";

const SPACE = "did:key:z6Mk-server-builtin-channel";
const ACTOR = "did:key:z6Mk-server-builtin-actor";
const claim: ExecutionClaim = {
  branch: "",
  space: SPACE,
  contextKey: "space",
  pieceId: "space:of:piece",
  actionId: "action:fetch",
  actionKind: "effect",
  implementationFingerprint: "impl:cf:builtin/fetchText:server-v1",
  runtimeFingerprint: "runner:scheduler:v3",
  leaseGeneration: 4,
  claimGeneration: 9,
  expiresAt: Date.now() + 30_000,
};

Deno.test("builtin broker channel preserves raw relative URLs and binds the host actor", async () => {
  const channel = new MessageChannel();
  const requests: unknown[] = [];
  const authorizations: unknown[] = [];
  const broker: ServerBuiltinFetchBroker = {
    fetch(request) {
      requests.push(request);
      return Promise.resolve({
        response: new Response("brokered", {
          status: 201,
          headers: { "x-broker": "yes" },
        }),
        finalUrl: new URL("https://toolshed.example/api/value"),
        redirectCount: 1,
      });
    },
  };
  const host = createServerBuiltinBrokerHost({
    port: channel.port1,
    context: {
      space: SPACE,
      branch: "",
      leaseGeneration: 4,
      onBehalfOf: ACTOR,
      servingOrigin: new URL("https://toolshed.example/"),
    },
    broker,
    isClaimLive: (candidate) =>
      candidate.claimGeneration === claim.claimGeneration,
    authorize: (request, context) => {
      authorizations.push({ request, context });
    },
  });
  const client = createServerBuiltinBrokerClient({
    port: channel.port2,
    claimForRequest: () => claim,
  });

  try {
    const response = await client.fetch("fetchText", "/api/value", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    assertEquals(response.status, 201);
    assertEquals(response.headers.get("x-broker"), "yes");
    assertEquals(await response.text(), "brokered");
    assertEquals((requests[0] as { url: string }).url, "/api/value");
    assertEquals(
      (authorizations[0] as { context: { onBehalfOf: string } }).context
        .onBehalfOf,
      ACTOR,
    );
  } finally {
    client.dispose();
    host.dispose();
  }
});

Deno.test("builtin broker channel rejects stale or lane-mismatched claims before egress", async () => {
  const channel = new MessageChannel();
  let calls = 0;
  const host = createServerBuiltinBrokerHost({
    port: channel.port1,
    context: {
      space: SPACE,
      branch: "",
      leaseGeneration: 4,
      onBehalfOf: ACTOR,
      servingOrigin: new URL("https://toolshed.example/"),
    },
    broker: {
      fetch() {
        calls++;
        throw new Error("must not execute");
      },
    },
    isClaimLive: () => false,
  });
  const client = createServerBuiltinBrokerClient({
    port: channel.port2,
    claimForRequest: () => ({ ...claim, claimGeneration: 10 }),
  });

  try {
    await assertRejects(
      () => client.fetch("fetchText", "/api/value"),
      Error,
      "live claim",
    );
    assertEquals(calls, 0);
  } finally {
    client.dispose();
    host.dispose();
  }
});

Deno.test("builtin broker channel propagates abort and cancels host work", async () => {
  const channel = new MessageChannel();
  let hostAborted = false;
  const host = createServerBuiltinBrokerHost({
    port: channel.port1,
    context: {
      space: SPACE,
      branch: "",
      leaseGeneration: 4,
      onBehalfOf: ACTOR,
      servingOrigin: new URL("https://toolshed.example/"),
    },
    broker: {
      fetch(request) {
        return new Promise((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => {
            hostAborted = true;
            reject(request.signal?.reason);
          }, { once: true });
        });
      },
    },
    isClaimLive: () => true,
  });
  const client = createServerBuiltinBrokerClient({
    port: channel.port2,
    claimForRequest: () => claim,
  });
  const controller = new AbortController();

  try {
    const pending = client.fetch("fetchText", "/slow", {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error("caller stopped"));
    await assertRejects(() => pending, Error, "caller stopped");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(hostAborted, true);
  } finally {
    client.dispose();
    host.dispose();
  }
});
