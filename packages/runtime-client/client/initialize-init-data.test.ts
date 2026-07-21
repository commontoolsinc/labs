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
 * `InitializationData` literal. `clientVersion` was silently dropped there once
 * (the unit tests that build `Runtime` directly could not catch it, so the
 * version-skew gate always failed and no space ever auto-updated).
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
  it("forwards clientVersion into the worker InitializationData", async () => {
    const identity = await Identity.fromPassphrase("init-data test");
    const transport = new CapturingTransport();

    await RuntimeClient.initialize(transport, {
      apiUrl: new URL("http://toolshed.test"),
      identity,
      spaceDid: identity.did(),
      clientVersion: "client-sha-xyz",
      experimental: {},
    });

    const init = transport.sent.find(
      (m): m is IPCClientMessage =>
        "msgId" in m && m.data?.type === RequestType.Initialize,
    );
    expect(init).toBeDefined();
    // request payload → { type: Initialize, data: InitializationData }
    const data = (init as { data: { data: { clientVersion?: string } } }).data
      .data;
    expect(data.clientVersion).toBe("client-sha-xyz");
  });

  it("forwards patternCoverage into the worker InitializationData", async () => {
    // The same drop-on-the-wire failure as clientVersion above: the flag is set
    // on RuntimeClientOptions but the hand-built InitializationData literal must
    // copy it, or the worker is built without a coverage collector and the
    // integration jobs collect nothing.
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

  it("re-emits a worker versionSkew notification as a client event", async () => {
    const identity = await Identity.fromPassphrase("skew forward test");
    const transport = new CapturingTransport();
    const client = await RuntimeClient.initialize(transport, {
      apiUrl: new URL("http://toolshed.test"),
      identity,
      spaceDid: identity.did(),
      experimental: {},
    });

    let received: { space?: string; toolshedVersion?: string } | undefined;
    let pending: boolean | undefined;
    client.on("versionskew", (msg) => (received = msg));
    client.on("pendingwriteschange", (e) => (pending = e.pending));

    // A pendingWrites notification first exercises the demux arm immediately
    // above versionSkew, so both the versionSkew arm and the branch it chains
    // off of are covered.
    transport.simulateMessage({
      type: NotificationType.PendingWritesChanged,
      pending: true,
    });
    // Worker → shell: the connection demuxes the notification and RuntimeClient
    // re-emits it (covers the guard, the connection dispatch arm, and the
    // client forwarder).
    transport.simulateMessage({
      type: NotificationType.VersionSkew,
      space: "did:key:z6Mk-skew",
      clientVersion: "c",
      toolshedVersion: "t",
    });

    expect(pending).toBe(true);
    expect(received?.space).toBe("did:key:z6Mk-skew");
    expect(received?.toolshedVersion).toBe("t");
  });
});
