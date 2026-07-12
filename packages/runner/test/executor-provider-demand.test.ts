import { assertEquals } from "@std/assert";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  type ResponseMessage,
} from "@commonfabric/memory/v2";
import { Server } from "@commonfabric/memory/v2/server";
import { createHostProviderChannel } from "../src/storage/v2-host-provider.ts";

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
