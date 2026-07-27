import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { RuntimeClient } from "../runtime-client.ts";
import { EventEmitter } from "./emitter.ts";
import { NotificationType, RequestType } from "../protocol/mod.ts";
import type {
  IPCClientMessage,
  IPCClientNotification,
  IPCRemoteMessage,
} from "../protocol/mod.ts";
import type { RuntimeTransport, RuntimeTransportEvents } from "./transport.ts";

/**
 * Guards the shell→worker `InitializationData` wiring: the fields carried by
 * `RuntimeClientOptions` must survive `RuntimeClient.initialize`'s hand-built
 * `InitializationData` literal.
 */
class CapturingTransport extends EventEmitter<RuntimeTransportEvents>
  implements RuntimeTransport {
  readonly sent: Array<IPCClientMessage | IPCClientNotification> = [];
  send(message: IPCClientMessage | IPCClientNotification): void {
    this.sent.push(message);
    if (!("msgId" in message)) return;
    queueMicrotask(() => {
      this.emit("message", { msgId: message.msgId, data: undefined });
    });
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }
  simulateMessage(message: IPCRemoteMessage): void {
    this.emit("message", message);
  }
}

describe("RuntimeClient.initialize InitializationData wiring", () => {
  it("forwards patternCoverage into the worker InitializationData", async () => {
    // The flag is set on RuntimeClientOptions but the hand-built
    // InitializationData literal must copy it, or the worker is built without
    // a coverage collector and the integration jobs collect nothing.
    const identity = await Identity.fromPassphrase("init-data coverage test");
    const transport = new CapturingTransport();

    await RuntimeClient.initialize(transport, {
      apiUrl: new URL("http://toolshed.test"),
      identity,
      spaceDid: identity.did(),
      experimental: {},
      patternCoverage: true,
    });

    const init = transport.sent.find(
      (m): m is IPCClientMessage =>
        "msgId" in m && m.data?.type === RequestType.Initialize,
    );
    expect(init).toBeDefined();
    const data = (init as { data: { data: { patternCoverage?: boolean } } })
      .data.data;
    expect(data.patternCoverage).toBe(true);
  });

  it("forwards concurrentWatchRefresh into the worker InitializationData", async () => {
    // Same silent-drop hazard as patternCoverage: the flag is set on
    // RuntimeClientOptions but the hand-built InitializationData literal must
    // copy it, or the worker opens storage with the default single-flight
    // settings and the dogfood toggle has no effect.
    const identity = await Identity.fromPassphrase(
      "init-data concurrent-watch-refresh test",
    );
    const transport = new CapturingTransport();

    await RuntimeClient.initialize(transport, {
      apiUrl: new URL("http://toolshed.test"),
      identity,
      spaceDid: identity.did(),
      experimental: {},
      concurrentWatchRefresh: true,
    });

    const init = transport.sent.find(
      (m): m is IPCClientMessage =>
        "msgId" in m && m.data?.type === RequestType.Initialize,
    );
    expect(init).toBeDefined();
    const data =
      (init as { data: { data: { concurrentWatchRefresh?: boolean } } })
        .data.data;
    expect(data.concurrentWatchRefresh).toBe(true);
  });
});

describe("RuntimeClient notification wiring", () => {
  it("re-emits PendingWritesChanged from the transport", async () => {
    const identity = await Identity.fromPassphrase(
      "pending writes notification test",
    );
    const transport = new CapturingTransport();
    const client = await RuntimeClient.initialize(transport, {
      apiUrl: new URL("http://toolshed.test"),
      identity,
      spaceDid: identity.did(),
      experimental: {},
    });
    let pending: boolean | undefined;
    client.on("pendingwriteschange", (event) => (pending = event.pending));

    try {
      transport.simulateMessage({
        type: NotificationType.PendingWritesChanged,
        pending: true,
      });
      expect(pending).toBe(true);
    } finally {
      await client.dispose();
    }
  });
});
