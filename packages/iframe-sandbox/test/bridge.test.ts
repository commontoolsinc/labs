/** Exercises the host and guest ends of the explicit capability protocol. */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { createFabricBridge, FabricBridgeHost } from "../src/bridge.ts";
import { connectFabric } from "../src/guest.ts";
import { GUEST_PORT_HANDOFF } from "../src/ipc.ts";

function handOff(port: MessagePort): void {
  globalThis.dispatchEvent(
    new MessageEvent("message", {
      data: GUEST_PORT_HANDOFF,
      ports: [port],
    }),
  );
}

describe("Fabric iframe bridge", () => {
  it("describes resources and performs cell operations", async () => {
    let count = 1;
    const listeners = new Set<(value: number) => void>();
    const bridge = createFabricBridge({
      count: {
        kind: "cell",
        schema: { type: "number", description: "Visible counter" },
        read: () => count,
        write: (value) => {
          count = value as number;
          for (const listener of listeners) listener(count);
        },
        subscribe: (listener) => {
          listeners.add(listener as (value: number) => void);
          listener(count);
          return () => listeners.delete(listener as (value: number) => void);
        },
      },
    });
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(bridge, channel.port1);
    const client = connectFabric();
    handOff(channel.port2);

    try {
      await expect(client.describe()).resolves.toEqual({
        protocol: "common-fabric-bridge",
        version: 1,
        resources: {
          count: {
            kind: "cell",
            methods: ["read", "write", "subscribe"],
            schema: { type: "number", description: "Visible counter" },
          },
        },
      });

      const remote = client.cell<number>("count");
      await expect(remote.read()).resolves.toBe(1);
      const updates: number[] = [];
      const unsubscribe = remote.subscribe((snapshot) => {
        if (snapshot.status === "ready") updates.push(snapshot.value);
      });
      await remote.write(2);
      await remote.read();
      expect(updates).toEqual([1, 2]);
      unsubscribe();
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("calls SQLite methods through the same discoverable resource", async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    const bridge = createFabricBridge({
      app: {
        kind: "sqlite",
        methods: {
          query: (input) => {
            calls.push({ method: "query", input });
            return { rows: [{ id: 1, title: "Ship it" }] };
          },
          exec: (input) => {
            calls.push({ method: "exec", input });
          },
        },
      },
    });
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(bridge, channel.port1);
    const client = connectFabric();
    handOff(channel.port2);

    try {
      const db = client.sqlite("app");
      await expect(db.query("SELECT * FROM todos")).resolves.toEqual({
        rows: [{ id: 1, title: "Ship it" }],
      });
      await db.exec("INSERT INTO todos(title) VALUES (?)", ["Test it"]);
      expect(calls).toEqual([{
        method: "query",
        input: { sql: "SELECT * FROM todos" },
      }, {
        method: "exec",
        input: {
          sql: "INSERT INTO todos(title) VALUES (?)",
          params: ["Test it"],
        },
      }]);
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("returns structured errors for missing capabilities", async () => {
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(createFabricBridge({}), channel.port1);
    const client = connectFabric();
    handOff(channel.port2);

    try {
      await expect(client.cell("missing").read()).rejects.toMatchObject({
        code: "resource-not-found",
        resource: "missing",
      });
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("refuses inherited resource and method names", async () => {
    const inheritedResources = Object.create({
      inherited: {
        kind: "service",
        methods: { run: () => "wrong" },
      },
    }) as Record<string, {
      kind: "service";
      methods: Record<string, () => string>;
    }>;
    const methods = Object.create({ inherited: () => "wrong" }) as Record<
      string,
      () => string
    >;
    methods.own = () => "right";
    inheritedResources.service = { kind: "service", methods };
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge(inheritedResources),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    try {
      await expect(client.call("inherited", "run")).rejects.toMatchObject({
        code: "resource-not-found",
      });
      await expect(client.call("service", "inherited")).rejects.toMatchObject({
        code: "method-not-supported",
      });
      await expect(client.call("service", "own")).resolves.toBe("right");
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("cancels host subscriptions when the guest disconnects", async () => {
    const subscribed = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge({
        watched: {
          kind: "cell",
          subscribe: () => {
            subscribed.resolve();
            return () => cancelled.resolve();
          },
        },
      }),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    client.subscribeResource("watched", () => {});
    await subscribed.promise;
    client.disconnect();
    await cancelled.promise;

    host.disconnect();
  });

  it("continues host teardown when one cancellation throws", async () => {
    const firstSubscribed = Promise.withResolvers<void>();
    const secondSubscribed = Promise.withResolvers<void>();
    let secondCancelled = false;
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge({
        first: {
          kind: "cell",
          subscribe: () => {
            firstSubscribed.resolve();
            return () => {
              throw new Error("cancel failed");
            };
          },
        },
        second: {
          kind: "cell",
          subscribe: () => {
            secondSubscribed.resolve();
            return () => {
              secondCancelled = true;
            };
          },
        },
      }),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    client.subscribeResource("first", () => {});
    await firstSubscribed.promise;
    client.subscribeResource("second", () => {});
    await secondSubscribed.promise;

    expect(() => host.disconnect()).not.toThrow();
    expect(secondCancelled).toBe(true);
    client.disconnect();
  });

  it("normalizes resource errors before sending them to the guest", async () => {
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge({
        guarded: {
          kind: "service",
          methods: {
            run: () => {
              throw { code: "denied", message: "Not allowed", resource: 42 };
            },
          },
        },
      }),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    try {
      await expect(client.call("guarded", "run")).rejects.toMatchObject({
        code: "denied",
        message: "Not allowed",
        resource: "guarded",
      });
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });
});
