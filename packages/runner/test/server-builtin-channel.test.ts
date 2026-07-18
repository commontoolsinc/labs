import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import type { ExecutionClaim } from "@commonfabric/memory/v2";
import {
  sessionExecutionContextKey,
  userExecutionContextKey,
} from "@commonfabric/memory/v2";
import {
  createServerBuiltinBrokerClient,
  createServerBuiltinBrokerHost,
  ServerBuiltinUnservedError,
} from "../src/executor/server-builtin-channel.ts";
import {
  createServerBuiltinEgressBroker,
  ServerBuiltinEgressError,
  type ServerBuiltinFetchBroker,
  type ServerBuiltinTransportRequest,
} from "../src/executor/server-builtin-egress.ts";
import { authorizeDefaultServerBuiltinRequest } from "../src/executor/server-builtin-transport.ts";
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

for (const redirectStatus of [307, 308] as const) {
  for (const redirectKind of ["same-origin", "cross-origin"] as const) {
    Deno.test(`${redirectKind} ${redirectStatus} redirect cannot enter a protected first-party POST target`, async () => {
      const channel = new MessageChannel();
      const dispatched: ServerBuiltinTransportRequest[] = [];
      const resolvedHosts: string[] = [];
      const broker = createServerBuiltinEgressBroker({
        servingOrigin: "https://toolshed.example/",
        resolveHostAddresses: (hostname) => {
          resolvedHosts.push(hostname);
          return Promise.resolve(["93.184.216.34"]);
        },
        transport: {
          request(request) {
            dispatched.push(request);
            if (dispatched.length === 1) {
              return new Response(null, {
                status: redirectStatus,
                headers: {
                  location: redirectKind === "same-origin"
                    ? "/api/sandbox/exec"
                    : "https://toolshed.example/api/sandbox/exec",
                },
              });
            }
            return new Response("protected target dispatched", { status: 200 });
          },
        },
      });
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
        isClaimLive: () => true,
        authorize: authorizeDefaultServerBuiltinRequest,
      });
      const client = createServerBuiltinBrokerClient({
        port: channel.port2,
        claimForRequest: () => claim,
      });

      try {
        const error = await assertRejects(
          () =>
            client.fetch(
              "fetchText",
              redirectKind === "same-origin"
                ? "/api/public"
                : "https://public.example/start",
              {
                method: "POST",
                headers: { "content-type": "text/plain" },
                body: "broker payload",
              },
            ),
          ServerBuiltinUnservedError,
          "protected first-party builtin request",
        );
        assertEquals(
          error.diagnosticCode,
          "server-builtin-authorization-denied",
        );
        assertEquals(dispatched.length, 1);
        assertEquals(dispatched[0].method, "POST");
        assertEquals(dispatched[0].body, "broker payload");
        assertEquals(
          resolvedHosts,
          redirectKind === "same-origin" ? [] : ["public.example"],
        );
      } finally {
        client.dispose();
        host.dispose();
      }
    });
  }
}

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

// ---------------------------------------------------------------------------
// C2.8 — scoped-lane builtin egress through the W1.4 broker channel: a
// claim naming a canonical user/session lane validates, carries the LANE's
// host-derived acting identity to the authorize policy (A23: lane identity
// crosses the channel, raw credentials do not), and receives the identical
// G11 egress policy the space lane gets. The space lane stays byte-identical.
// ---------------------------------------------------------------------------

const LANE_PRINCIPAL = "did:key:z6Mk-server-builtin-lane-alice";
const LANE_SESSION_ID = "builtin-lane-session-1";
const SESSION_LANE_KEY = sessionExecutionContextKey(
  LANE_PRINCIPAL,
  LANE_SESSION_ID,
);
const USER_LANE_KEY = userExecutionContextKey(LANE_PRINCIPAL);

Deno.test("C2.8: scoped-lane claims flow through the broker with the lane's derived acting identity", async () => {
  for (
    const [contextKey, expectedIdentity] of [
      [SESSION_LANE_KEY, {
        lane: "session",
        principal: LANE_PRINCIPAL,
        sessionId: LANE_SESSION_ID,
      }],
      [USER_LANE_KEY, { lane: "user", principal: LANE_PRINCIPAL }],
      ["space", { lane: "space", onBehalfOf: ACTOR }],
    ] as const
  ) {
    const channel = new MessageChannel();
    const requests: unknown[] = [];
    const identities: unknown[] = [];
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
          requests.push(request);
          return Promise.resolve({
            response: new Response("brokered"),
            finalUrl: new URL("https://toolshed.example/api/value"),
            redirectCount: 0,
          });
        },
      },
      isClaimLive: () => true,
      authorize: (request) => {
        identities.push(request.actingIdentity);
      },
    });
    const client = createServerBuiltinBrokerClient({
      port: channel.port2,
      claimForRequest: () => ({
        ...claim,
        contextKey: contextKey as ExecutionClaim["contextKey"],
      }),
    });
    try {
      const response = await client.fetch("fetchText", "/api/value");
      assertEquals(response.status, 200, contextKey);
      assertEquals(requests.length, 1, contextKey);
      // The acting identity is host-DERIVED from the validated claim's
      // contextKey — the wire request itself still carries no identity
      // field beyond the claim (the AUTHORITY_FIELDS forgery check).
      assertEquals(identities, [expectedIdentity], contextKey);
    } finally {
      client.dispose();
      host.dispose();
    }
  }
});

Deno.test("C2.8: non-canonical scoped lane keys reject before egress (regression)", async () => {
  // A raw-concatenated (never percent-encoded) or empty-segment lane key
  // can only come from a fabricated identity; the wire validator refuses it
  // exactly as it refuses forged authority fields.
  for (
    const contextKey of [
      `user:${LANE_PRINCIPAL}`, // raw colons — not canonical
      "user:",
      `session:${LANE_PRINCIPAL}:${LANE_SESSION_ID}`, // raw colons
      "session::",
    ]
  ) {
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
    });
    const client = createServerBuiltinBrokerClient({
      port: channel.port2,
      claimForRequest: () => ({
        ...claim,
        contextKey: contextKey as ExecutionClaim["contextKey"],
      }),
    });
    try {
      await assertRejects(
        () => client.fetch("fetchText", "/api/value"),
        Error,
        "invalid server builtin request",
        contextKey,
      );
      assertEquals(calls, 0, contextKey);
    } finally {
      client.dispose();
      host.dispose();
    }
  }
});

Deno.test("C2.8 (f): the G11 egress policy is identical per lane — blocked destinations and serving-origin resolution", async () => {
  // The egress broker is deliberately identity-independent (it polices
  // URLs, DNS, and redirects — never identities), so G11 parity per lane is
  // pinned rather than parameterized: the SAME broker instance serves every
  // lane's claims, a loopback absolute URL rejects `blocked-destination`
  // for scoped-lane claims exactly as for space, and a relative URL
  // resolves against the trusted serving origin for every lane.
  for (
    const contextKey of ["space", USER_LANE_KEY, SESSION_LANE_KEY] as const
  ) {
    const channel = new MessageChannel();
    const dispatched: ServerBuiltinTransportRequest[] = [];
    const broker = createServerBuiltinEgressBroker({
      servingOrigin: "https://toolshed.example/",
      resolveHostAddresses: () => Promise.resolve(["93.184.216.34"]),
      transport: {
        request(request) {
          dispatched.push(request);
          return new Response("served", { status: 200 });
        },
      },
    });
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
      isClaimLive: () => true,
      authorize: authorizeDefaultServerBuiltinRequest,
    });
    const client = createServerBuiltinBrokerClient({
      port: channel.port2,
      claimForRequest: () => ({
        ...claim,
        contextKey: contextKey as ExecutionClaim["contextKey"],
      }),
    });
    try {
      // Relative path resolves against the trusted serving origin.
      const relative = await client.fetch("fetchText", "/api/public");
      assertEquals(relative.status, 200, contextKey);
      assertEquals(
        dispatched[0]?.url.href,
        "https://toolshed.example/api/public",
        contextKey,
      );
      assertEquals(dispatched[0]?.trustedServingOrigin, true, contextKey);
      // A loopback absolute destination is blocked identically per lane.
      const blocked = await assertRejects(
        () => client.fetch("fetchText", "http://127.0.0.1:9/value"),
        ServerBuiltinUnservedError,
        "",
        contextKey,
      );
      assertEquals(
        (blocked as ServerBuiltinUnservedError).diagnosticCode,
        "server-builtin-egress-blocked-destination",
        contextKey,
      );
      assertEquals(dispatched.length, 1, contextKey);
    } finally {
      client.dispose();
      host.dispose();
    }
  }
});
