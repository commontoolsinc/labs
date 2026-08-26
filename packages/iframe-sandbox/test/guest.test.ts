import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  connectFabric,
  type FabricClient,
  RemoteCell,
  reportGuestError,
} from "../src/guest.ts";
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

    it("snapshots queued request arguments before capability handoff", async () => {
      const fabric = connectFabric();
      try {
        const value = { n: 1 };
        const writing = fabric.cell<{ n: number }>("record").write(value);
        value.n = 2;

        const host = handOffPort();
        const request = await receive(host);
        expect(request.value).toEqual({ n: 1 });
        send(host, response(request.id));
        await writing;
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
            resources: [],
          }),
        );

        await expect(pending).resolves.toMatchObject({ resources: [] });
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

    it("preserves an authoritative update that precedes a write response", async () => {
      const fabric = connectFabric();
      try {
        const host = handOffPort();
        const cell = fabric.cell<number>("count");
        cell.subscribe(() => {});
        const subscribe = await receive(host);
        send(host, response(subscribe.id));

        const writing = cell.write(2);
        const write = await receive(host);
        send(host, {
          protocol: BRIDGE_PROTOCOL,
          version: BRIDGE_VERSION,
          type: "event",
          subscription: subscribe.subscription!,
          value: 3,
        });
        send(host, response(write.id));
        await writing;

        expect(cell.getSnapshot()).toEqual({ status: "ready", value: 3 });
      } finally {
        fabric.disconnect();
      }
    });

    it("preserves an authoritative update that precedes a read response", async () => {
      const fabric = connectFabric();
      try {
        const host = handOffPort();
        const cell = fabric.cell<number>("count");
        cell.subscribe(() => {});
        const subscribe = await receive(host);
        send(host, response(subscribe.id));

        const reading = cell.read();
        const read = await receive(host);
        send(host, {
          protocol: BRIDGE_PROTOCOL,
          version: BRIDGE_VERSION,
          type: "event",
          subscription: subscribe.subscription!,
          value: 2,
        });
        send(host, response(read.id, 1));
        await expect(reading).resolves.toBe(1);

        expect(cell.getSnapshot()).toEqual({ status: "ready", value: 2 });
      } finally {
        fabric.disconnect();
      }
    });

    it("preserves an equal authoritative update over an older read", async () => {
      const fabric = connectFabric();
      try {
        const host = handOffPort();
        const cell = fabric.cell<number>("count");
        cell.subscribe(() => {});
        const subscribe = await receive(host);
        send(host, response(subscribe.id));
        send(host, {
          protocol: BRIDGE_PROTOCOL,
          version: BRIDGE_VERSION,
          type: "event",
          subscription: subscribe.subscription!,
          value: 1,
        });

        const reading = cell.read();
        const read = await receive(host);
        send(host, {
          protocol: BRIDGE_PROTOCOL,
          version: BRIDGE_VERSION,
          type: "event",
          subscription: subscribe.subscription!,
          value: 1,
        });
        send(host, response(read.id, 0));
        await expect(reading).resolves.toBe(0);

        expect(cell.getSnapshot()).toEqual({ status: "ready", value: 1 });
      } finally {
        fabric.disconnect();
      }
    });

    it("preserves an equal authoritative update over a write response", async () => {
      const fabric = connectFabric();
      try {
        const host = handOffPort();
        const cell = fabric.cell<number>("count");
        const ready = Promise.withResolvers<void>();
        cell.subscribe((snapshot) => {
          if (snapshot.status === "ready" && snapshot.value === 1) {
            ready.resolve();
          }
        });
        const subscribe = await receive(host);
        send(host, response(subscribe.id));
        send(host, {
          protocol: BRIDGE_PROTOCOL,
          version: BRIDGE_VERSION,
          type: "event",
          subscription: subscribe.subscription!,
          value: 1,
        });
        await ready.promise;

        const writing = cell.write(2);
        const write = await receive(host);
        send(host, {
          protocol: BRIDGE_PROTOCOL,
          version: BRIDGE_VERSION,
          type: "event",
          subscription: subscribe.subscription!,
          value: 1,
        });
        send(host, response(write.id));
        await writing;

        expect(cell.getSnapshot()).toEqual({ status: "ready", value: 1 });
      } finally {
        fabric.disconnect();
      }
    });

    it("publishes the later of two overlapping reads", async () => {
      const responses = [
        Promise.withResolvers<FabricValue | undefined>(),
        Promise.withResolvers<FabricValue | undefined>(),
      ];
      let request = 0;
      const client = {
        request: () => responses[request++]!.promise,
      } as unknown as FabricClient;
      const cell = new RemoteCell<number>(client, "count");

      const first = cell.read();
      const second = cell.read();
      responses[0].resolve(1);
      await expect(first).resolves.toBe(1);
      responses[1].resolve(2);
      await expect(second).resolves.toBe(2);

      expect(cell.getSnapshot()).toEqual({ status: "ready", value: 2 });
    });

    it("serializes overlapping writes before publishing the latest value", async () => {
      const firstResponse = Promise.withResolvers<FabricValue | undefined>();
      const writes: number[] = [];
      const client = {
        request: (
          operation: string,
          fields: { value?: FabricValue },
        ) => {
          expect(operation).toBe("write");
          writes.push(fields.value as number);
          return writes.length === 1
            ? firstResponse.promise
            : Promise.resolve(undefined);
        },
      } as unknown as FabricClient;
      const cell = new RemoteCell<number>(client, "count");

      const first = cell.write(1);
      const second = cell.write(2);
      await Promise.resolve();
      expect(writes).toEqual([1]);

      firstResponse.resolve(undefined);
      await Promise.all([first, second]);
      expect(writes).toEqual([1, 2]);
      expect(cell.getSnapshot()).toEqual({ status: "ready", value: 2 });
    });

    it("orders a read after every previously queued write", async () => {
      const firstResponse = Promise.withResolvers<FabricValue | undefined>();
      const operations: Array<[string, FabricValue | undefined]> = [];
      const client = {
        request: (operation: string, fields: { value?: FabricValue }) => {
          operations.push([operation, fields.value]);
          if (operation === "read") return Promise.resolve(2);
          return fields.value === 1
            ? firstResponse.promise
            : Promise.resolve(undefined);
        },
      } as unknown as FabricClient;
      const cell = new RemoteCell<number>(client, "count");

      const first = cell.write(1);
      const second = cell.write(2);
      const reading = cell.read();
      expect(operations).toEqual([["write", 1]]);

      firstResponse.resolve(undefined);
      await Promise.all([first, second, reading]);
      expect(operations).toEqual([
        ["write", 1],
        ["write", 2],
        ["read", undefined],
      ]);
    });

    it("serializes updater writes on the shared remote cell", async () => {
      const firstStarted = Promise.withResolvers<void>();
      const firstResponse = Promise.withResolvers<FabricValue | undefined>();
      const writes: number[] = [];
      const client = {
        request: (operation: string, fields: { value?: FabricValue }) => {
          if (operation === "read") return Promise.resolve(1);
          writes.push(fields.value as number);
          if (writes.length === 1) firstStarted.resolve();
          return writes.length === 1
            ? firstResponse.promise
            : Promise.resolve(undefined);
        },
      } as unknown as FabricClient;
      const cell = new RemoteCell<number>(client, "count");

      const first = cell.update((value) => value + 1);
      const second = cell.update((value) => value + 1);
      await firstStarted.promise;
      expect(writes).toEqual([2]);

      firstResponse.resolve(undefined);
      await Promise.all([first, second]);
      expect(writes).toEqual([2, 3]);
    });

    it("waits for an active read before applying an updater", async () => {
      const latestRead = Promise.withResolvers<FabricValue | undefined>();
      const writes: number[] = [];
      let reads = 0;
      const client = {
        request: (operation: string, fields: { value?: FabricValue }) => {
          if (operation === "read") {
            return reads++ === 0 ? Promise.resolve(1) : latestRead.promise;
          }
          writes.push(fields.value as number);
          return Promise.resolve(undefined);
        },
      } as unknown as FabricClient;
      const cell = new RemoteCell<number>(client, "count");

      await expect(cell.read()).resolves.toBe(1);
      const reading = cell.read();
      const updating = cell.update((value) => value + 1);
      await Promise.resolve();
      expect(writes).toEqual([]);

      latestRead.resolve(2);
      await Promise.all([reading, updating]);
      expect(writes).toEqual([3]);
      expect(cell.getSnapshot()).toEqual({ status: "ready", value: 3 });
    });

    it("cleans up a request when sending it fails synchronously", async () => {
      const fabric = connectFabric();
      try {
        handOffPort();
        const value = Object.fromEntries([
          ["constructor", 1],
        ]) as FabricValue;

        await expect(fabric.call("service", "method", value)).rejects.toThrow(
          "Cannot encode an object with a key this runtime reserves",
        );
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
