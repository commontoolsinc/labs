import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { connectGuestContext, reportGuestError } from "../src/guest.ts";
import {
  GUEST_PORT_HANDOFF,
  type GuestMessage,
  GuestMessageType,
  HostMessageType,
} from "../src/ipc.ts";

// Stands in for the host: holds the far end of the channel, and delivers the
// handoff the way a window message carrying a transferred port arrives.
function handOffPort(): MessagePort {
  const channel = new MessageChannel();
  channel.port1.start();
  globalThis.dispatchEvent(
    new MessageEvent("message", {
      data: GUEST_PORT_HANDOFF,
      ports: [channel.port2],
    }),
  );
  return channel.port1;
}

// Resolves with the next `count` messages the host end receives.
function received(port: MessagePort, count: number): Promise<GuestMessage[]> {
  const messages: GuestMessage[] = [];
  return new Promise((resolve) => {
    port.onmessage = (event: MessageEvent) => {
      messages.push(event.data as GuestMessage);
      if (messages.length === count) resolve(messages);
    };
  });
}

// Lets whatever the ports have queued be delivered.
function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("guest", () => {
  describe("connectGuestContext", () => {
    it("sends what was said before the port arrived, in the order said", async () => {
      const guest = connectGuestContext(() => {});
      try {
        guest.read("first");
        guest.write("second", 2);
        guest.subscribe("third");

        const host = handOffPort();
        expect(await received(host, 3)).toEqual([
          { type: GuestMessageType.Read, data: "first" },
          { type: GuestMessageType.Write, data: ["second", 2] },
          { type: GuestMessageType.Subscribe, data: ["third"] },
        ]);
      } finally {
        guest.disconnect();
      }
    });

    it("sends an unsubscribe naming every key given", async () => {
      const guest = connectGuestContext(() => {});
      try {
        const host = handOffPort();
        guest.unsubscribe("a", "b");
        expect(await received(host, 1)).toEqual([
          { type: GuestMessageType.Unsubscribe, data: ["a", "b"] },
        ]);
      } finally {
        guest.disconnect();
      }
    });

    it("passes an update's key and value to the handler", async () => {
      const seen: [string, unknown][] = [];
      const guest = connectGuestContext((key, value) =>
        seen.push([key, value])
      );
      try {
        const host = handOffPort();
        host.postMessage({
          type: HostMessageType.Update,
          data: ["counted", 9n],
        });
        await settled();
        expect(seen).toEqual([["counted", 9n]]);
      } finally {
        guest.disconnect();
      }
    });

    it("ignores port traffic that is not an update it can read", async () => {
      const seen: [string, unknown][] = [];
      const guest = connectGuestContext((key, value) =>
        seen.push([key, value])
      );
      try {
        const host = handOffPort();
        for (
          const bad of [
            undefined,
            { type: "something-else" },
            { type: HostMessageType.Update },
            { type: HostMessageType.Update, data: ["solo"] },
            { type: HostMessageType.Update, data: [7, "non-string key"] },
          ]
        ) {
          host.postMessage(bad);
        }
        await settled();
        expect(seen).toEqual([]);
      } finally {
        guest.disconnect();
      }
    });

    it("keeps the first port it is given", async () => {
      const guest = connectGuestContext(() => {});
      try {
        const host = handOffPort();
        handOffPort();
        guest.write("k", 1);
        expect(await received(host, 1)).toEqual([
          { type: GuestMessageType.Write, data: ["k", 1] },
        ]);
      } finally {
        guest.disconnect();
      }
    });

    it("stops listening once disconnected", async () => {
      const seen: [string, unknown][] = [];
      const guest = connectGuestContext((key, value) =>
        seen.push([key, value])
      );
      const host = handOffPort();
      guest.disconnect();

      host.postMessage({ type: HostMessageType.Update, data: ["late", 1] });
      await settled();
      expect(seen).toEqual([]);
    });
  });

  describe("reportGuestError", () => {
    it("posts the error to the guest's parent", () => {
      const posted: unknown[] = [];
      const parent = { postMessage: (data: unknown) => posted.push(data) };
      const original = Reflect.get(globalThis, "parent");
      Reflect.set(globalThis, "parent", parent);
      try {
        reportGuestError({
          description: "boom",
          source: "s",
          lineno: 1,
          colno: 2,
          stacktrace: "st",
        });
      } finally {
        Reflect.set(globalThis, "parent", original);
      }

      expect(posted).toEqual([{
        type: GuestMessageType.Error,
        data: {
          description: "boom",
          source: "s",
          lineno: 1,
          colno: 2,
          stacktrace: "st",
        },
      }]);
    });
  });
});
