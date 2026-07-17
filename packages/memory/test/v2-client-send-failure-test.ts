/**
 * A transport send that fails after the connection turned over (the deflate
 * transport's drain-window guard, a dial failure) must not leave orphaned
 * pending state behind: a later connection-close sweep rejecting a promise
 * nobody observes is a fatal unhandled rejection in Deno processes. These
 * tests fail via Deno's unhandled-rejection detection if the cleanup
 * regresses.
 */
import { describe, it } from "@std/testing/bdd";
import { assertEquals, assertRejects } from "@std/assert";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
} from "../v2.ts";
import { Client, type Transport } from "../v2/client.ts";

const HELLO_OK = {
  type: "hello.ok",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
  sessionOpen: {
    audience: "did:key:z6Mk-send-failure-audience",
    challenge: { value: "challenge:send-failure", expiresAt: 1_000_000 },
  },
} as const;

const connectionError = (): Error => {
  const error = new Error(
    "memory websocket transport reconnected during send",
  );
  error.name = "ConnectionError";
  return error;
};

describe("memory v2 client transport send failures", () => {
  it("withdraws the pending request when send fails, so the close sweep cannot reject an unobserved promise", async () => {
    let receiver = (_payload: string) => {};
    let closeReceiver: (error?: Error) => void = () => {};
    let failSends = false;
    const transport: Transport = {
      send(payload: string): Promise<void> {
        if (failSends) return Promise.reject(connectionError());
        const message = JSON.parse(payload.slice("fvj1:".length)) as {
          type?: string;
        };
        if (message.type === "hello") {
          queueMicrotask(() => receiver(encodeMemoryBoundary(HELLO_OK)));
        }
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
      setReceiver(next) {
        receiver = next;
      },
      setCloseReceiver(next) {
        closeReceiver = next;
      },
    };

    const client = await Client.connect({ transport });
    assertEquals(client.isConnected(), true);

    // The connection is now "turning over": sends fail with a retryable
    // connection error while the close notification has not yet landed.
    failSends = true;
    await assertRejects(
      () =>
        client.request({
          type: "graph.query",
          requestId: crypto.randomUUID(),
          space: "did:key:z6Mk-send-failure",
          sessionId: "session:none",
          query: { roots: [] },
        }),
      Error,
      "reconnected during send",
    );

    // The close notification sweeps pending requests. If the failed request
    // above left its entry behind, this rejects a promise with no handlers
    // and Deno's unhandled-rejection tracking fails this test.
    closeReceiver(connectionError());
    await new Promise((resolve) => setTimeout(resolve, 10));
    await client.close();
  });

  it("clears the pending hello when the handshake send fails", async () => {
    let closeReceiver: (error?: Error) => void = () => {};
    const transport: Transport = {
      send: () => Promise.reject(connectionError()),
      close: () => Promise.resolve(),
      setReceiver() {},
      setCloseReceiver(next) {
        closeReceiver = next;
      },
    };

    await assertRejects(
      () => Client.connect({ transport }),
      Error,
      "reconnected during send",
    );
    closeReceiver(connectionError());
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
