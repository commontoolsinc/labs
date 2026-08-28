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
        const result = fabric.cell<number>("count").pull();
        const host = handOffPort();
        const request = await receive(host);
        expect(request).toEqual({
          protocol: BRIDGE_PROTOCOL,
          version: BRIDGE_VERSION,
          type: "request",
          id: 0,
          operation: "pull",
          resource: "count",
          path: [],
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
        const writing = fabric.cell<{ n: number }>("record").set(value);
        value.n = 2;

        const host = handOffPort();
        const request = await receive(host);
        expect(request.value).toEqual({ n: 1 });
        send(host, response(request.id));
        await writing;
        expect(fabric.cell<{ n: number }>("record").getSnapshot()).toEqual({
          status: "ready",
          value: { n: 1 },
        });
      } finally {
        fabric.disconnect();
      }
    });

    it("rejects initialize when a version-two host does not advertise it", async () => {
      const fabric = connectFabric();
      try {
        const initializing = fabric.cell<number>("count").initialize(0);
        const host = handOffPort();
        const describe = await receive(host);
        expect(describe.operation).toBe("describe");
        send(
          host,
          response(describe.id, {
            protocol: BRIDGE_PROTOCOL,
            version: BRIDGE_VERSION,
            resources: [{
              name: "count",
              kind: "cell",
              operations: ["get", "pull", "set", "sink"],
              methods: [],
            }],
          }),
        );

        await expect(initializing).rejects.toMatchObject({
          code: "method-not-supported",
          resource: "count",
        });
      } finally {
        fabric.disconnect();
      }
    });

    it("sends initialize after a version-two host advertises it", async () => {
      const fabric = connectFabric();
      try {
        const initializing = fabric.cell<number>("count").initialize(0);
        const host = handOffPort();
        const describe = await receive(host);
        send(
          host,
          response(describe.id, {
            protocol: BRIDGE_PROTOCOL,
            version: BRIDGE_VERSION,
            resources: [{
              name: "count",
              kind: "cell",
              operations: ["get", "initialize", "pull", "set", "sink"],
              methods: [],
            }],
          }),
        );
        const request = await receive(host);
        expect(request).toMatchObject({
          operation: "initialize",
          resource: "count",
          path: [],
          value: 0,
        });
        send(host, response(request.id, 4));

        await expect(initializing).resolves.toBe(4);
      } finally {
        fabric.disconnect();
      }
    });

    it("does not reuse a cached manifest after disconnect", async () => {
      const fabric = connectFabric();
      const describing = fabric.describe();
      const host = handOffPort();
      const request = await receive(host);
      send(
        host,
        response(request.id, {
          protocol: BRIDGE_PROTOCOL,
          version: BRIDGE_VERSION,
          resources: [],
        }),
      );
      await expect(describing).resolves.toMatchObject({ resources: [] });

      fabric.disconnect();

      await expect(fabric.describe()).rejects.toMatchObject({
        code: "disconnected",
      });
    });

    it("negotiates initialize through resolved cell capabilities", async () => {
      const fabric = connectFabric();
      try {
        const host = handOffPort();
        const firstResolution = fabric.cell<number>("count").resolve();
        const firstResolve = await receive(host);
        send(
          host,
          response(firstResolve.id, {
            handle: "cell-1",
            hasValue: true,
            value: 1,
          }),
        );
        const first = await firstResolution;

        const secondResolution = first.resolve();
        const secondResolve = await receive(host);
        expect(secondResolve.handle).toBe("cell-1");
        send(
          host,
          response(secondResolve.id, {
            handle: "cell-2",
            hasValue: true,
            value: 1,
          }),
        );
        const second = await secondResolution;

        const initializing = second.initialize(0);
        const describe = await receive(host);
        expect(describe.operation).toBe("describe");
        send(
          host,
          response(describe.id, {
            protocol: BRIDGE_PROTOCOL,
            version: BRIDGE_VERSION,
            resources: [{
              name: "count",
              kind: "cell",
              operations: ["get", "initialize", "pull", "set", "sink"],
              methods: [],
            }],
          }),
        );
        const request = await receive(host);
        expect(request).toMatchObject({
          operation: "initialize",
          handle: "cell-2",
          path: [],
          value: 0,
        });
        send(host, response(request.id, 4));

        await expect(initializing).resolves.toBe(4);
      } finally {
        fabric.disconnect();
      }
    });

    it("lets an available port perform the request snapshot", async () => {
      const fabric = connectFabric();
      const originalStructuredClone = globalThis.structuredClone;
      let cloneCalls = 0;
      globalThis.structuredClone = ((...args) => {
        cloneCalls++;
        return originalStructuredClone(...args);
      }) as typeof structuredClone;
      try {
        const host = handOffPort();
        const received = receive(host);
        const value = { n: 1 };
        const cell = fabric.cell<{ n: number }>("record");
        const writing = cell.set(value);

        expect(cloneCalls).toBe(0);
        const request = await received;
        expect(request.value).toEqual({ n: 1 });
        value.n = 2;
        send(host, response(request.id));
        await writing;
        expect(cell.getSnapshot()).toEqual({
          status: "ready",
          value: { n: 1 },
        });
      } finally {
        globalThis.structuredClone = originalStructuredClone;
        fabric.disconnect();
      }
    });

    it("exposes sink events as stable cell snapshots", async () => {
      const fabric = connectFabric();
      try {
        const host = handOffPort();
        const cell = fabric.cell<number>("count");
        const ready = new Promise<void>((resolve) => {
          cell.subscribeSnapshot((snapshot) => {
            if (snapshot.status === "ready" && snapshot.value === 4) resolve();
          });
        });
        const request = await receive(host);
        expect(request.operation).toBe("sink");
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

    it("does not publish an equivalent object twice after a set", async () => {
      const fabric = connectFabric();
      try {
        const host = handOffPort();
        const cell = fabric.cell<{ count: number }>("state");
        const snapshots: unknown[] = [];
        cell.subscribeSnapshot((snapshot) => snapshots.push(snapshot));
        const subscribe = await receive(host);
        send(host, response(subscribe.id));
        snapshots.length = 0;

        const writing = cell.set({ count: 2 });
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

    it("preserves an authoritative update that precedes a set response", async () => {
      const fabric = connectFabric();
      try {
        const host = handOffPort();
        const cell = fabric.cell<number>("count");
        cell.subscribeSnapshot(() => {});
        const subscribe = await receive(host);
        send(host, response(subscribe.id));

        const writing = cell.set(2);
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

    it("preserves an authoritative update that precedes a pull response", async () => {
      const fabric = connectFabric();
      try {
        const host = handOffPort();
        const cell = fabric.cell<number>("count");
        cell.subscribeSnapshot(() => {});
        const subscribe = await receive(host);
        send(host, response(subscribe.id));

        const reading = cell.pull();
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

    it("preserves an equal authoritative update over an older pull", async () => {
      const fabric = connectFabric();
      try {
        const host = handOffPort();
        const cell = fabric.cell<number>("count");
        cell.subscribeSnapshot(() => {});
        const subscribe = await receive(host);
        send(host, response(subscribe.id));
        send(host, {
          protocol: BRIDGE_PROTOCOL,
          version: BRIDGE_VERSION,
          type: "event",
          subscription: subscribe.subscription!,
          value: 1,
        });

        const reading = cell.pull();
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

    it("preserves an equal authoritative update over a set response", async () => {
      const fabric = connectFabric();
      try {
        const host = handOffPort();
        const cell = fabric.cell<number>("count");
        const ready = Promise.withResolvers<void>();
        cell.subscribeSnapshot((snapshot) => {
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

        const writing = cell.set(2);
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

    it("publishes the later of two overlapping pulls", async () => {
      const responses = [
        Promise.withResolvers<FabricValue | undefined>(),
        Promise.withResolvers<FabricValue | undefined>(),
      ];
      let request = 0;
      const client = {
        request: () => responses[request++]!.promise,
      } as unknown as FabricClient;
      const cell = new RemoteCell<number>(client, "count");

      const first = cell.pull();
      const second = cell.pull();
      responses[0].resolve(1);
      await expect(first).resolves.toBe(1);
      responses[1].resolve(2);
      await expect(second).resolves.toBe(2);

      expect(cell.getSnapshot()).toEqual({ status: "ready", value: 2 });
    });

    it("serializes overlapping sets before publishing the latest value", async () => {
      const firstResponse = Promise.withResolvers<FabricValue | undefined>();
      const writes: number[] = [];
      const client = {
        request: (
          operation: string,
          fields: { value?: FabricValue },
        ) => {
          expect(operation).toBe("set");
          writes.push(fields.value as number);
          return writes.length === 1
            ? firstResponse.promise
            : Promise.resolve(undefined);
        },
      } as unknown as FabricClient;
      const cell = new RemoteCell<number>(client, "count");

      const first = cell.set(1);
      const second = cell.set(2);
      await Promise.resolve();
      expect(writes).toEqual([1]);

      firstResponse.resolve(undefined);
      await Promise.all([first, second]);
      expect(writes).toEqual([1, 2]);
      expect(cell.getSnapshot()).toEqual({ status: "ready", value: 2 });
    });

    it("publishes the winner returned by atomic initialization", async () => {
      const requests: Array<{
        operation: string;
        value?: FabricValue;
      }> = [];
      const client = {
        request: (
          operation: string,
          fields: { value?: FabricValue },
        ) => {
          requests.push({ operation, value: fields.value });
          return Promise.resolve({ count: 7 });
        },
      } as unknown as FabricClient;
      const cell = new RemoteCell<{ count: number }>(client, "state");

      await expect(cell.initialize({ count: 0 })).resolves.toEqual({
        count: 7,
      });
      expect(requests).toEqual([{
        operation: "initialize",
        value: { count: 0 },
      }]);
      expect(cell.getSnapshot()).toEqual({
        status: "ready",
        value: { count: 7 },
      });
    });

    it("orders a pull after every previously queued set", async () => {
      const firstResponse = Promise.withResolvers<FabricValue | undefined>();
      const operations: Array<[string, FabricValue | undefined]> = [];
      const client = {
        request: (operation: string, fields: { value?: FabricValue }) => {
          operations.push([operation, fields.value]);
          if (operation === "pull") return Promise.resolve(2);
          return fields.value === 1
            ? firstResponse.promise
            : Promise.resolve(undefined);
        },
      } as unknown as FabricClient;
      const cell = new RemoteCell<number>(client, "count");

      const first = cell.set(1);
      const second = cell.set(2);
      const reading = cell.pull();
      expect(operations).toEqual([["set", 1]]);

      firstResponse.resolve(undefined);
      await Promise.all([first, second, reading]);
      expect(operations).toEqual([
        ["set", 1],
        ["set", 2],
        ["pull", undefined],
      ]);
    });

    it("orders path operations with their root cell", async () => {
      const fabric = connectFabric();
      try {
        const host = handOffPort();
        const root = fabric.cell<{ count: number }>("state");
        const child = root.key("count");

        const first = root.set({ count: 1 });
        const firstRequest = await receive(host);
        expect(firstRequest.operation).toBe("set");

        const second = root.set({ count: 2 });
        const reading = child.pull();
        send(host, response(firstRequest.id));

        const secondRequest = await receive(host);
        expect(secondRequest).toMatchObject({
          operation: "set",
          resource: "state",
          path: [],
          value: { count: 2 },
        });
        send(host, response(secondRequest.id));

        const pullRequest = await receive(host);
        expect(pullRequest).toMatchObject({
          operation: "pull",
          resource: "state",
          path: ["count"],
        });
        send(host, response(pullRequest.id, 2));

        await Promise.all([first, second, reading]);
      } finally {
        fabric.disconnect();
      }
    });

    it("serializes updater sets on the shared remote cell", async () => {
      const firstStarted = Promise.withResolvers<void>();
      const firstResponse = Promise.withResolvers<FabricValue | undefined>();
      const writes: number[] = [];
      const client = {
        request: (operation: string, fields: { value?: FabricValue }) => {
          if (operation === "pull") return Promise.resolve(1);
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

    it("waits for an active pull before applying an updater", async () => {
      const latestRead = Promise.withResolvers<FabricValue | undefined>();
      const writes: number[] = [];
      let reads = 0;
      const client = {
        request: (operation: string, fields: { value?: FabricValue }) => {
          if (operation === "pull") {
            return reads++ === 0 ? Promise.resolve(1) : latestRead.promise;
          }
          writes.push(fields.value as number);
          return Promise.resolve(undefined);
        },
      } as unknown as FabricClient;
      const cell = new RemoteCell<number>(client, "count");

      await expect(cell.pull()).resolves.toBe(1);
      const reading = cell.pull();
      const updating = cell.update((value) => value + 1);
      await Promise.resolve();
      expect(writes).toEqual([]);

      latestRead.resolve(2);
      await Promise.all([reading, updating]);
      expect(writes).toEqual([3]);
      expect(cell.getSnapshot()).toEqual({ status: "ready", value: 3 });
    });

    it("keeps a plain set newer than an active pull", async () => {
      const readResponse = Promise.withResolvers<FabricValue | undefined>();
      const writeResponse = Promise.withResolvers<FabricValue | undefined>();
      const operations: string[] = [];
      const client = {
        request: (operation: string) => {
          operations.push(operation);
          return operation === "pull"
            ? readResponse.promise
            : writeResponse.promise;
        },
      } as unknown as FabricClient;
      const cell = new RemoteCell<number>(client, "count");

      const reading = cell.pull();
      const writing = cell.set(2);
      readResponse.resolve(1);
      await expect(reading).resolves.toBe(1);
      writeResponse.resolve(undefined);
      await writing;

      expect(operations).toEqual(["pull", "set"]);
      expect(cell.getSnapshot()).toEqual({ status: "ready", value: 2 });
    });

    it("continues a plain set after an active pull fails", async () => {
      const readResponse = Promise.withResolvers<FabricValue | undefined>();
      const writeResponse = Promise.withResolvers<FabricValue | undefined>();
      const operations: string[] = [];
      const client = {
        request: (operation: string) => {
          operations.push(operation);
          return operation === "pull"
            ? readResponse.promise
            : writeResponse.promise;
        },
      } as unknown as FabricClient;
      const cell = new RemoteCell<number>(client, "count");
      const failure = new Error("read failed");

      const reading = cell.pull();
      const writing = cell.set(2);
      readResponse.reject(failure);
      await expect(reading).rejects.toBe(failure);
      writeResponse.resolve(undefined);
      await writing;

      expect(operations).toEqual(["pull", "set"]);
      expect(cell.getSnapshot()).toEqual({ status: "ready", value: 2 });
    });

    it("reports invocation snapshot failures as rejected sets", async () => {
      let requests = 0;
      const client = {
        request: () => {
          requests++;
          return Promise.resolve(undefined);
        },
      } as unknown as FabricClient;
      const cell = new RemoteCell<FabricValue>(client, "record");
      const cyclic = {} as Record<string, FabricValue>;
      cyclic.self = cyclic;
      let writing: Promise<void> | undefined;

      expect(() => {
        writing = cell.set(cyclic);
      }).not.toThrow();
      await expect(writing!).rejects.toThrow(
        "Cannot deep-clone circular reference",
      );
      expect(requests).toBe(0);
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
