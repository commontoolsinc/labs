import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import type { DID } from "@commonfabric/identity";

import {
  ClientNotificationType,
  ClientTransportNotificationType,
  type InitializationData,
  NotificationType,
  RequestType,
  type RuntimeSecurityContext,
} from "@/protocol/mod.ts";
import type { RuntimeProcessor } from "@/backends/mod.ts";
import { RuntimeClients } from "@/backends/client-registry.ts";
import type { WorkerClient } from "@/backends/worker-client.ts";

type Posted = Record<string, unknown>;

const spaceDid = "did:key:z6Mk-runtime-clients-space" as DID;
const identityDid = "did:key:z6Mk-runtime-clients-identity" as DID;

const runningContext: RuntimeSecurityContext = {
  identity: identityDid,
  spaceDid,
  cfcEnforcementMode: "enforce-strict",
};

const initializationData = {
  apiUrl: "http://runtime-clients.test/",
  identity: { placeholder: true },
  spaceDid,
  cfcEnforcementMode: "enforce-strict",
} as unknown as InitializationData;

/** A capturing client, standing in for one end of a duplex. */
function testClient(id: number) {
  const posted: Posted[] = [];
  const client: WorkerClient = {
    id,
    post: (message) => {
      posted.push(message as unknown as Posted);
      return true;
    },
  };
  return { client, posted };
}

/**
 * A processor that records what the message loop asked of it. Standing a real
 * one up wants identities and storage, and what these tests turn on is which
 * client each call carries and what a refusal says.
 */
function fakeProcessor() {
  const requests: Array<{ type: RequestType; clientId: number }> = [];
  const notifications: Array<{ type: string; clientId: number }> = [];
  const disposedClients: number[] = [];
  let runtimeDisposals = 0;
  const processor = {
    isDisposed: () => false,
    assertAttachable: (asserted: RuntimeSecurityContext) => {
      if (asserted.identity === runningContext.identity) return;
      throw new Error(
        "Attach refused: the asserted security context differs from the " +
          "runtime's at `identity`.",
      );
    },
    handleRequest: (
      request: { type: RequestType },
      client: WorkerClient,
    ) => {
      requests.push({ type: request.type, clientId: client.id });
      return Promise.resolve(undefined);
    },
    handleNotification: (
      notification: { type: string },
      client: WorkerClient,
    ) => {
      notifications.push({ type: notification.type, clientId: client.id });
    },
    disposeClient: (client: WorkerClient) => {
      disposedClients.push(client.id);
    },
    dispose: () => {
      runtimeDisposals += 1;
      return Promise.resolve();
    },
  };
  return {
    processor: processor as unknown as RuntimeProcessor,
    requests,
    notifications,
    disposedClients,
    runtimeDisposals: () => runtimeDisposals,
  };
}

function harness() {
  const fake = fakeProcessor();
  const owner = testClient(0);
  const consoleBridge: boolean[] = [];
  const clients = new RuntimeClients({
    owner: owner.client,
    setConsoleBridge: (enabled) => consoleBridge.push(enabled),
    initializeRuntime: () => Promise.resolve(fake.processor),
  });
  const deliver = (client: WorkerClient, message: unknown, ports?: unknown[]) =>
    clients.handleMessage(
      client,
      new MessageEvent("message", {
        // Encoded as a client's transport sends it: the loop decodes every
        // arriving envelope, so a raw object reads as damaged.
        data: realmFromFabricValue(message as never),
        ...(ports === undefined
          ? {}
          : { ports: ports as unknown as MessagePort[] }),
      }),
    );
  const initialize = (msgId: number) =>
    deliver(owner.client, {
      msgId,
      data: { type: RequestType.Initialize, data: initializationData },
    });
  return { ...fake, clients, owner, consoleBridge, deliver, initialize };
}

/**
 * Reads one client's end of a channel, recording every message and handing out
 * a promise for the next one. A reply is a real event, so a test waits on the
 * reply itself rather than on a delay chosen to outlast it.
 */
function portReader(port: MessagePort) {
  const received: Posted[] = [];
  let arrived: (() => void) | undefined;
  port.addEventListener("message", (event) => {
    received.push(fabricFromRealmValue(event.data as never) as Posted);
    arrived?.();
    arrived = undefined;
  });
  port.start();
  return {
    received,
    /** Settles on the next message to arrive. Called before what prompts it. */
    next: () => new Promise<void>((resolve) => (arrived = resolve)),
  };
}

/** Hands the worker a port and returns this end of it. */
async function attachPort(h: ReturnType<typeof harness>) {
  const channel = new MessageChannel();
  const reader = portReader(channel.port1);
  await h.deliver(
    h.owner.client,
    { type: ClientTransportNotificationType.AttachPort },
    [channel.port2],
  );
  return { channel, ...reader };
}

/** Attaches a client over a real channel and returns its far end. */
async function attachedClient(
  h: ReturnType<typeof harness>,
  context: RuntimeSecurityContext = runningContext,
) {
  const port = await attachPort(h);
  const replied = port.next();
  port.channel.port1.postMessage(
    realmFromFabricValue(
      { msgId: 1, data: { type: RequestType.Attach, data: context } } as never,
    ),
  );
  await replied;
  return port;
}

describe("RuntimeClients", () => {
  describe("instance members", () => {
    describe("handleMessage()", () => {
      it("acks the owner's `Initialize` and stands the runtime up", async () => {
        const h = harness();
        await h.initialize(1);
        expect(h.owner.posted).toEqual([{ msgId: 1 }]);
      });

      it("refuses a second `Initialize`", async () => {
        const h = harness();
        await h.initialize(1);
        h.owner.posted.length = 0;
        await h.initialize(2);
        expect(h.owner.posted).toEqual([{
          msgId: 2,
          error: "Initialization of WorkerRuntime already attempted.",
        }]);
      });

      it("refuses a request before the runtime is initialized", async () => {
        const h = harness();
        await h.deliver(h.owner.client, {
          msgId: 1,
          data: { type: RequestType.Idle },
        });
        expect(h.owner.posted).toEqual([{
          msgId: 1,
          error: "WorkerRuntime not initialized.",
        }]);
      });

      it("answers `SetForwardWorkerConsole` before any initialization", async () => {
        const h = harness();
        await h.deliver(h.owner.client, {
          msgId: 1,
          data: { type: RequestType.SetForwardWorkerConsole, enabled: true },
        });
        expect(h.owner.posted).toEqual([{ msgId: 1 }]);
        expect(h.consoleBridge).toEqual([true]);
      });

      it("carries the owner's client into every handled request", async () => {
        const h = harness();
        await h.initialize(1);
        await h.deliver(h.owner.client, {
          msgId: 2,
          data: { type: RequestType.Idle },
        });
        expect(h.requests).toEqual([{
          type: RequestType.Idle,
          clientId: 0,
        }]);
      });

      it("carries the owner's client into every notification", async () => {
        const h = harness();
        await h.initialize(1);
        await h.deliver(h.owner.client, {
          type: ClientNotificationType.VDomBatchApplied,
          mountId: 1,
          batchId: 2,
        });
        expect(h.notifications).toEqual([{
          type: ClientNotificationType.VDomBatchApplied,
          clientId: 0,
        }]);
      });

      it("tears the runtime down on the owner's `Dispose`", async () => {
        const h = harness();
        await h.initialize(1);
        await h.deliver(h.owner.client, {
          msgId: 2,
          data: { type: RequestType.Dispose },
        });
        expect(h.requests).toEqual([{
          type: RequestType.Dispose,
          clientId: 0,
        }]);
        expect(h.disposedClients).toEqual([]);
      });
    });

    describe("attach()", () => {
      it("acks an attach whose security context is the runtime's", async () => {
        const h = harness();
        await h.initialize(1);
        const { received, channel } = await attachedClient(h);
        channel.port1.close();
        expect(received).toEqual([{ msgId: 1 }]);
      });

      it("refuses an attach whose security context differs", async () => {
        const h = harness();
        await h.initialize(1);
        const { received, channel } = await attachedClient(h, {
          ...runningContext,
          identity: "did:key:z6Mk-someone-else" as DID,
        });
        channel.port1.close();
        expect(received).toHaveLength(1);
        expect(received[0].msgId).toBe(1);
        expect(received[0].error).toContain("Attach refused");
        expect(received[0].error).toContain("`identity`");
      });

      it("refuses an attach before the runtime is initialized", async () => {
        const h = harness();
        const { received, channel } = await attachedClient(h);
        channel.port1.close();
        expect(received).toEqual([{
          msgId: 1,
          error: "WorkerRuntime not initialized.",
        }]);
      });

      it("refuses an `Attach` from the client that owns the worker", async () => {
        const h = harness();
        await h.initialize(1);
        h.owner.posted.length = 0;
        await h.deliver(h.owner.client, {
          msgId: 2,
          data: { type: RequestType.Attach, data: runningContext },
        });
        expect(h.owner.posted).toHaveLength(1);
        expect(h.owner.posted[0].error).toContain(
          "initializes its runtime rather than attaching",
        );
      });

      it("refuses a request from a client that has not attached", async () => {
        const h = harness();
        await h.initialize(1);
        const port = await attachPort(h);
        try {
          const replied = port.next();
          port.channel.port1.postMessage(
            realmFromFabricValue(
              { msgId: 5, data: { type: RequestType.Idle } } as never,
            ),
          );
          await replied;
          expect(port.received).toEqual([{
            msgId: 5,
            error: "Client is not attached to the WorkerRuntime.",
          }]);
          expect(h.requests).toEqual([]);
        } finally {
          port.channel.port1.close();
        }
      });

      it("carries the attached client into its own requests", async () => {
        const h = harness();
        await h.initialize(1);
        const port = await attachedClient(h);
        try {
          const replied = port.next();
          port.channel.port1.postMessage(
            realmFromFabricValue(
              { msgId: 2, data: { type: RequestType.Idle } } as never,
            ),
          );
          await replied;
          expect(h.requests).toEqual([{ type: RequestType.Idle, clientId: 1 }]);
        } finally {
          port.channel.port1.close();
        }
      });

      it("tears down only the departing client on an attached `Dispose`", async () => {
        const h = harness();
        await h.initialize(1);
        const port = await attachedClient(h);
        try {
          const replied = port.next();
          port.channel.port1.postMessage(
            realmFromFabricValue(
              { msgId: 2, data: { type: RequestType.Dispose } } as never,
            ),
          );
          await replied;
          expect(h.disposedClients).toEqual([1]);
          expect(h.runtimeDisposals()).toBe(0);
          expect(h.requests).toEqual([]);
        } finally {
          port.channel.port1.close();
        }
      });

      it("refuses a port transferred by a client that is not the owner", async () => {
        const h = harness();
        await h.initialize(1);
        const attached = await attachedClient(h);
        attached.received.length = 0;
        const second = new MessageChannel();
        try {
          const reported = attached.next();
          attached.channel.port1.postMessage(
            realmFromFabricValue(
              { type: ClientTransportNotificationType.AttachPort } as never,
            ),
            [second.port2],
          );
          await reported;
          expect(attached.received).toHaveLength(1);
          expect(attached.received[0].type).toBe(NotificationType.ErrorReport);
          expect(attached.received[0].message).toContain(
            "Only the client that owns the worker",
          );
        } finally {
          attached.channel.port1.close();
          second.port1.close();
        }
      });

      it("reports an attach-port message that carries no port", async () => {
        const h = harness();
        await h.initialize(1);
        h.owner.posted.length = 0;
        await h.deliver(h.owner.client, {
          type: ClientTransportNotificationType.AttachPort,
        });
        expect(h.owner.posted).toHaveLength(1);
        expect(h.owner.posted[0].type).toBe(NotificationType.ErrorReport);
        expect(h.owner.posted[0].message).toContain("no port");
      });
    });
  });
});
