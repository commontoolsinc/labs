import { assertEquals } from "@std/assert";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  type ResponseMessage,
} from "@commonfabric/memory/v2";
import { Server } from "@commonfabric/memory/v2/server";
import {
  createHostProviderChannel,
  HostStorageManager,
} from "../src/storage/v2-host-provider.ts";

const SPACE = "did:key:z6Mk-executor-provider-demand-space";

Deno.test("executor host provider rejects client demand before canonical registration", async () => {
  const server = new Server({
    authorizeSessionOpen: () => SPACE,
    sessionOpenAuth: { audience: SPACE },
    protocolFlags: { serverPrimaryExecutionV1: true },
  });
  const channel = createHostProviderChannel({
    server,
    space: SPACE,
    authorizeSessionOpen: (_space, _session, context) => ({
      invocation: {
        aud: context.audience,
        challenge: context.challenge.value,
      },
      authorization: { principal: SPACE },
    }),
  });
  const response = Promise.withResolvers<ResponseMessage<never>>();
  channel.port.addEventListener("message", (event: MessageEvent<unknown>) => {
    const envelope = event.data as { type?: unknown; payload?: unknown };
    if (envelope.type !== "memory" || typeof envelope.payload !== "string") {
      return;
    }
    const message = decodeMemoryBoundary(envelope.payload);
    if (
      typeof message === "object" && message !== null &&
      (message as { type?: unknown }).type === "response" &&
      (message as { requestId?: unknown }).requestId === "demand:spoof"
    ) {
      response.resolve(message as ResponseMessage<never>);
    }
  });
  channel.port.start();

  try {
    channel.port.postMessage({
      type: "memory",
      payload: encodeMemoryBoundary({
        type: "session.execution.demand.set",
        requestId: "demand:spoof",
        space: SPACE,
        sessionId: "session:executor",
        branch: "",
        pieces: ["piece:one"],
      }),
    });

    assertEquals(await response.promise, {
      type: "response",
      requestId: "demand:spoof",
      error: {
        name: "AuthorizationError",
        message: "executor providers cannot originate client execution demand",
      },
    });
    assertEquals(server.listExecutionDemands(SPACE, ""), []);
  } finally {
    await channel.dispose();
    await server.close();
  }
});

Deno.test("executor host provider rejects legacy background control", async () => {
  const server = new Server({
    authorizeSessionOpen: () => SPACE,
    sessionOpenAuth: { audience: SPACE },
    protocolFlags: { serverPrimaryExecutionV1: true },
    acl: { mode: "off", serviceDids: [SPACE] },
  });
  const channel = createHostProviderChannel({
    server,
    space: SPACE,
    authorizeSessionOpen: (_space, _session, context) => ({
      invocation: {
        aud: context.audience,
        challenge: context.challenge.value,
      },
      authorization: { principal: SPACE },
    }),
  });
  const responses = new Map<
    string,
    PromiseWithResolvers<ResponseMessage<never>>
  >();
  channel.port.addEventListener("message", (event: MessageEvent<unknown>) => {
    const envelope = event.data as { type?: unknown; payload?: unknown };
    if (envelope.type !== "memory" || typeof envelope.payload !== "string") {
      return;
    }
    const message = decodeMemoryBoundary(envelope.payload);
    if (typeof message !== "object" || message === null) return;
    const requestId = (message as { requestId?: unknown }).requestId;
    if (typeof requestId !== "string") return;
    responses.get(requestId)?.resolve(message as ResponseMessage<never>);
  });
  channel.port.start();

  try {
    for (
      const [operation, extra] of [
        ["acquire", {}],
        ["renew", { exclusionGeneration: 1 }],
        ["release", { exclusionGeneration: 1 }],
      ] as const
    ) {
      const requestId = `legacy-background:${operation}`;
      const response = Promise.withResolvers<ResponseMessage<never>>();
      responses.set(requestId, response);
      channel.port.postMessage({
        type: "memory",
        payload: encodeMemoryBoundary({
          type: `session.execution.legacy-background.${operation}`,
          requestId,
          space: SPACE,
          sessionId: "session:executor",
          branch: "",
          ...extra,
        }),
      });
      assertEquals(await response.promise, {
        type: "response",
        requestId,
        error: {
          name: "AuthorizationError",
          message:
            "executor providers cannot control legacy background execution",
        },
      });
    }
  } finally {
    await channel.dispose();
    await server.close();
  }
});

Deno.test("shadow executor host provider rejects leaked upstream transactions", async () => {
  const server = new Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: { audience: SPACE },
  });
  const channel = createHostProviderChannel({
    server,
    space: SPACE,
    shadowWrites: true,
    authorizeSessionOpen: (_space, _session, context) => ({
      invocation: {
        aud: context.audience,
        challenge: context.challenge.value,
      },
      authorization: { principal: SPACE },
    }),
  });
  const storage = HostStorageManager.connect({
    port: channel.port,
    principal: SPACE,
    space: SPACE,
  });

  try {
    const result = await storage.open(SPACE).replica.commitNative!({
      operations: [{
        op: "set",
        id: "of:shadow-leak",
        type: "application/json",
        value: { value: { leaked: true } },
      }],
    });

    assertEquals(result.error?.name, "TransactionError");
    assertEquals(
      result.error?.message.includes(
        "shadow executor providers cannot transact upstream",
      ),
      true,
    );
    assertEquals(await server.readDocument(SPACE, "of:shadow-leak"), null);
  } finally {
    await storage.close();
    await channel.dispose();
    await server.close();
  }
});
