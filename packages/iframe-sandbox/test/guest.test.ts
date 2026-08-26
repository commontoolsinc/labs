import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { connectFabric, reportGuestError } from "../src/guest.ts";
import {
  BRIDGE_PROTOCOL,
  BRIDGE_VERSION,
  type BridgeHostMessage,
  type BridgeRequest,
  GUEST_PORT_HANDOFF,
} from "../src/ipc.ts";

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

function receive(port: MessagePort): Promise<BridgeRequest> {
  return new Promise((resolve) => {
    port.addEventListener("message", (event) => {
      resolve(fabricFromRealmValue(event.data) as BridgeRequest);
    }, { once: true });
  });
}

function send(port: MessagePort, message: BridgeHostMessage): void {
  port.postMessage(realmFromFabricValue(message));
}

function response(
  id: number,
  value?: FabricValue,
): BridgeHostMessage {
  return {
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_VERSION,
    type: "response",
    id,
    ok: true,
    ...(value !== undefined && { value }),
  };
}

describe("guest", () => {
  describe("connectFabric", () => {
    it("queues a request until the capability port arrives", async () => {
      const fabric = connectFabric();
      try {
        const result = fabric.cell<number>("count").read();
        const host = handOffPort();
        const request = await receive(host);
        expect(request).toEqual({
          protocol: BRIDGE_PROTOCOL,
          version: BRIDGE_VERSION,
          type: "request",
          id: 0,
          operation: "read",
          resource: "count",
        });
        send(host, response(request.id, 3));
        expect(await result).toBe(3);
      } finally {
        fabric.disconnect();
      }
    });

    it("exposes subscription events as stable cell snapshots", async () => {
      const fabric = connectFabric();
      try {
        const host = handOffPort();
        const cell = fabric.cell<number>("count");
        const ready = new Promise<void>((resolve) => {
          cell.subscribe((snapshot) => {
            if (snapshot.status === "ready" && snapshot.value === 4) resolve();
          });
        });
        const request = await receive(host);
        expect(request.operation).toBe("subscribe");
        expect(request.subscription).toBe("subscription-0");
        send(host, response(request.id));
        send(host, {
          protocol: BRIDGE_PROTOCOL,
          version: BRIDGE_VERSION,
          type: "event",
          subscription: request.subscription!,
          value: 4,
        });

        await ready;
        expect(cell.getSnapshot()).toEqual({ status: "ready", value: 4 });
      } finally {
        fabric.disconnect();
      }
    });

    it("accepts the capability port only from the host window", async () => {
      const attacker = new MessageChannel();
      const host = new MessageChannel();
      host.port1.start();
      const hostSource = host.port1 as unknown as Window;
      const originalParent = Reflect.get(globalThis, "parent");
      Reflect.set(globalThis, "parent", { parent: hostSource });
      const fabric = connectFabric();
      let pending: Promise<unknown> | undefined;
      try {
        pending = fabric.describe();
        globalThis.dispatchEvent(
          new MessageEvent("message", {
            data: GUEST_PORT_HANDOFF,
            ports: [attacker.port2],
            source: attacker.port1,
          }),
        );
        globalThis.dispatchEvent(
          new MessageEvent("message", {
            data: GUEST_PORT_HANDOFF,
            ports: [host.port2],
            source: host.port1,
          }),
        );
        const request = await receive(host.port1);
        send(
          host.port1,
          response(request.id, {
            protocol: BRIDGE_PROTOCOL,
            version: BRIDGE_VERSION,
            resources: {},
          }),
        );

        await expect(pending).resolves.toMatchObject({ resources: {} });
      } finally {
        fabric.disconnect();
        await pending?.catch(() => {});
        attacker.port1.close();
        host.port1.close();
        Reflect.set(globalThis, "parent", originalParent);
      }
    });

    it("does not publish an equivalent object twice after a write", async () => {
      const fabric = connectFabric();
      try {
        const host = handOffPort();
        const cell = fabric.cell<{ count: number }>("state");
        const snapshots: unknown[] = [];
        cell.subscribe((snapshot) => snapshots.push(snapshot));
        const subscribe = await receive(host);
        send(host, response(subscribe.id));
        snapshots.length = 0;

        const writing = cell.write({ count: 2 });
        const write = await receive(host);
        send(host, {
          protocol: BRIDGE_PROTOCOL,
          version: BRIDGE_VERSION,
          type: "event",
          subscription: subscribe.subscription!,
          value: { count: 2 },
        });
        send(host, response(write.id));
        await writing;

        expect(snapshots).toEqual([{
          status: "ready",
          value: { count: 2 },
        }]);
      } finally {
        fabric.disconnect();
      }
    });

    it("rejects pending work when disconnected", async () => {
      const fabric = connectFabric();
      const pending = fabric.describe();
      fabric.disconnect();

      await expect(pending).rejects.toMatchObject({
        name: "FabricBridgeError",
        code: "disconnected",
      });
    });
  });

  describe("reportGuestError", () => {
    it("posts an alarm to the guest's parent", () => {
      const posted: unknown[] = [];
      const parent = { postMessage: (data: unknown) => posted.push(data) };
      const original = Reflect.get(globalThis, "parent");
      Reflect.set(globalThis, "parent", parent);
      try {
        reportGuestError({
          description: "boom",
          source: "source",
          lineno: 1,
          colno: 2,
          stacktrace: "stack",
        });
      } finally {
        Reflect.set(globalThis, "parent", original);
      }

      expect(posted).toEqual([{
        type: "error",
        data: {
          description: "boom",
          source: "source",
          lineno: 1,
          colno: 2,
          stacktrace: "stack",
        },
      }]);
    });
  });
});
