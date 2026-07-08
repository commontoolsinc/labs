import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { RuntimeClient } from "../runtime-client.ts";
import { EventEmitter } from "./emitter.ts";
import { RequestType } from "../protocol/mod.ts";
import type {
  IPCClientMessage,
  IPCClientNotification,
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
});
