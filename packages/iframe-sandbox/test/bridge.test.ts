/** Exercises the host and guest ends of the explicit capability protocol. */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

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

function nextTask(): Promise<void> {
  const channel = new MessageChannel();
  return new Promise((resolve) => {
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
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
    const output = new FabricBytes(new Uint8Array([1, 2, 3]));
    const input = new FabricBytes(new Uint8Array([4, 5, 6]));
    const bridge = createFabricBridge({
      app: {
        kind: "sqlite",
        methods: {
          query: (input) => {
            calls.push({ method: "query", input });
            return { rows: [{ id: 1, title: "Ship it", payload: output }] };
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
      const result = await db.query<{ payload: FabricBytes }>(
        "SELECT * FROM todos",
      );
      expect(result.rows[0]?.payload).toBeInstanceOf(FabricBytes);
      expect(result.rows[0]?.payload.slice()).toEqual(
        new Uint8Array([1, 2, 3]),
      );
      await db.exec("INSERT INTO todos(title, payload) VALUES (?, ?)", [
        "Test it",
        input,
      ]);
      expect(calls[0]).toEqual({
        method: "query",
        input: { sql: "SELECT * FROM todos" },
      });
      expect(calls[1]).toMatchObject({
        method: "exec",
        input: {
          sql: "INSERT INTO todos(title, payload) VALUES (?, ?)",
        },
      });
      const params = (calls[1]?.input as { params: unknown[] }).params;
      expect(params[1]).toBeInstanceOf(FabricBytes);
      expect((params[1] as FabricBytes).slice()).toEqual(
        new Uint8Array([4, 5, 6]),
      );
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("completes earlier writes before later reads", async () => {
    let value = 0;
    const writeStarted = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge({
        count: {
          kind: "cell",
          read: () => value,
          write: async (next) => {
            writeStarted.resolve();
            await releaseWrite.promise;
            value = next as number;
          },
        },
      }),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    try {
      const writing = client.cell<number>("count").write(1);
      await writeStarted.promise;
      const reading = client.cell<number>("count").read();
      await nextTask();
      releaseWrite.resolve();

      await writing;
      await expect(reading).resolves.toBe(1);
    } finally {
      client.disconnect();
      host.disconnect();
    }
  });

  it("drops queued capability calls after host disconnect", async () => {
    let calls = 0;
    const channel = new MessageChannel();
    const host = new FabricBridgeHost(
      createFabricBridge({
        service: {
          kind: "service",
          methods: { mutate: () => calls++ },
        },
      }),
      channel.port1,
    );
    const client = connectFabric();
    handOff(channel.port2);

    const pending = client.call("service", "mutate");
    host.disconnect();
    await nextTask();
    await nextTask();
    expect(calls).toBe(0);
    client.disconnect();
    await pending.catch(() => {});
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
