import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import type { ExecutionClaim } from "@commonfabric/memory/v2";
import {
  createServerBuiltinBrokerClient,
  createServerBuiltinBrokerHost,
  ServerBuiltinUnservedError,
} from "../src/executor/server-builtin-channel.ts";
import {
  ServerBuiltinEgressError,
  type ServerBuiltinFetchBroker,
} from "../src/executor/server-builtin-egress.ts";
import {
  SERVER_EXECUTABLE_BUILTIN_IDS,
  serverBuiltinImplementationHash,
} from "../src/builtins/server-execution.ts";

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

Deno.test("builtin broker channel serves every canonical builtin without adding ambient fetch", async () => {
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
    claimForRequest: (builtinId) => ({
      ...claim,
      actionId: `action:${builtinId}`,
      implementationFingerprint: `impl:${
        serverBuiltinImplementationHash(builtinId)
      }`,
    }),
  });

  try {
    for (const builtinId of SERVER_EXECUTABLE_BUILTIN_IDS) {
      const response = await client.fetch(
        builtinId,
        `/api/value/${builtinId}`,
        {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "hello",
        },
      );
      assertEquals(response.status, 201);
      assertEquals(response.headers.get("x-broker"), "yes");
      assertEquals(await response.text(), "brokered");
    }
    assertEquals(
      requests.map((request) => (request as { url: string }).url),
      SERVER_EXECUTABLE_BUILTIN_IDS.map((id) => `/api/value/${id}`),
    );
    assertEquals(
      authorizations.map((authorization) =>
        (authorization as {
          request: { builtinId: string };
        }).request.builtinId
      ),
      [...SERVER_EXECUTABLE_BUILTIN_IDS],
    );
    assertEquals(
      authorizations.every((authorization) =>
        (authorization as { context: { onBehalfOf: string } }).context
          .onBehalfOf === ACTOR
      ),
      true,
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

Deno.test("builtin broker channel tags permanent authorization denial without egress", async () => {
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
    isClaimLive: () => true,
    authorize: () => {
      throw new ServerBuiltinUnservedError(
        "server-builtin-authorization-denied",
        "protected route requires delegation",
      );
    },
  });
  const client = createServerBuiltinBrokerClient({
    port: channel.port2,
    claimForRequest: () => claim,
  });

  try {
    const error = await assertRejects(
      () => client.fetch("fetchText", "/api/protected"),
      ServerBuiltinUnservedError,
      "requires delegation",
    );
    assertEquals(
      (error as ServerBuiltinUnservedError).diagnosticCode,
      "server-builtin-authorization-denied",
    );
    assertEquals(calls, 0);
  } finally {
    client.dispose();
    host.dispose();
  }
});

Deno.test("builtin broker channel distinguishes permanent egress policy from transient failure", async () => {
  const exercise = async (code: "blocked-destination" | "request-timeout") => {
    const channel = new MessageChannel();
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
          throw new ServerBuiltinEgressError(code, `egress ${code}`);
        },
      },
      isClaimLive: () => true,
    });
    const client = createServerBuiltinBrokerClient({
      port: channel.port2,
      claimForRequest: () => claim,
    });
    try {
      return await assertRejects(
        () => client.fetch("fetchText", "https://external.example/value"),
        Error,
        code,
      );
    } finally {
      client.dispose();
      host.dispose();
    }
  };

  const permanent = await exercise("blocked-destination");
  assertInstanceOf(permanent, ServerBuiltinUnservedError);
  assertEquals(
    (permanent as ServerBuiltinUnservedError).diagnosticCode,
    "server-builtin-egress-blocked-destination",
  );
  const transient = await exercise("request-timeout");
  assertEquals(transient instanceof ServerBuiltinUnservedError, false);
  assertEquals(
    (transient as Error & { code?: string }).code,
    "request-timeout",
  );
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

Deno.test("builtin broker channel cancels while an asynchronous claim check is pending", async () => {
  const channel = new MessageChannel();
  const claimCheck = Promise.withResolvers<boolean>();
  const claimCheckStarted = Promise.withResolvers<void>();
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
        return Promise.resolve({
          response: new Response("must not execute"),
          finalUrl: new URL("https://toolshed.example/slow"),
          redirectCount: 0,
        });
      },
    },
    isClaimLive: () => {
      claimCheckStarted.resolve();
      return claimCheck.promise;
    },
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
    await claimCheckStarted.promise;
    controller.abort(new Error("caller stopped during claim check"));
    await assertRejects(
      () => pending,
      Error,
      "caller stopped during claim check",
    );
    claimCheck.resolve(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(calls, 0);
  } finally {
    client.dispose();
    host.dispose();
  }
});
