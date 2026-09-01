import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";

import {
  type ErrorNotification,
  NotificationType,
  RequestType,
} from "@/protocol/mod.ts";
import { MessagePortRuntimeTransport } from "@/client/transports/message-port/transport-message-port.ts";

/**
 * Both ends of a real channel: the transport speaks over one, and the test
 * reads and writes the other as the worker would.
 */
function connectedPair() {
  const channel = new MessageChannel();
  const transport = new MessagePortRuntimeTransport({ port: channel.port1 });
  const received: unknown[] = [];
  let arrived: (() => void) | undefined;
  channel.port2.addEventListener("message", (event) => {
    received.push(fabricFromRealmValue(event.data as never));
    arrived?.();
    arrived = undefined;
  });
  channel.port2.start();
  return {
    transport,
    far: channel.port2,
    received,
    /** Settles on the next message the far end reads. */
    next: () => new Promise<void>((resolve) => (arrived = resolve)),
  };
}

describe("MessagePortRuntimeTransport", () => {
  describe("instance members", () => {
    describe("send()", () => {
      it("delivers the encoded envelope to the far end", async () => {
        const { transport, far, received, next } = connectedPair();
        try {
          const delivered = next();
          transport.send({
            msgId: 1,
            data: { type: RequestType.Idle },
          });
          await delivered;
          expect(received).toEqual([{
            msgId: 1,
            data: { type: RequestType.Idle },
          }]);
        } finally {
          await transport.dispose();
          far.close();
        }
      });
    });

    describe("dispose()", () => {
      it("stops emitting messages that arrive after it", async () => {
        const { transport, far } = connectedPair();
        const seen: unknown[] = [];
        transport.on("message", (message) => seen.push(message));
        try {
          await transport.dispose();
          far.postMessage(realmFromFabricValue({ msgId: 1 } as never));
          // The port is closed, so nothing can arrive; a yield gives anything
          // still queued its chance to be wrong.
          await Promise.resolve();
          expect(seen).toEqual([]);
        } finally {
          far.close();
        }
      });
    });

    describe("message handling", () => {
      it("emits a decoded response from the far end", async () => {
        const { transport, far } = connectedPair();
        const seen: unknown[] = [];
        let arrived: (() => void) | undefined;
        transport.on("message", (message) => {
          seen.push(message);
          arrived?.();
        });
        try {
          const emitted = new Promise<void>((resolve) => (arrived = resolve));
          far.postMessage(
            realmFromFabricValue({ msgId: 7, data: { value: true } } as never),
          );
          await emitted;
          expect(seen).toEqual([{ msgId: 7, data: { value: true } }]);
        } finally {
          await transport.dispose();
          far.close();
        }
      });

      it("reports a message that does not decode as an error notification", async () => {
        const { transport, far } = connectedPair();
        const seen: ErrorNotification[] = [];
        let arrived: (() => void) | undefined;
        transport.on("message", (message) => {
          seen.push(message as ErrorNotification);
          arrived?.();
        });
        try {
          const emitted = new Promise<void>((resolve) => (arrived = resolve));
          far.postMessage({ not: "an encoding" });
          await emitted;
          expect(seen).toHaveLength(1);
          expect(seen[0].type).toBe(NotificationType.ErrorReport);
          expect(seen[0].message).toContain("Undecodable message");
        } finally {
          await transport.dispose();
          far.close();
        }
      });
    });
  });
});
