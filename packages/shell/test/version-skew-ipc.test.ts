import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  EventEmitter,
  NotificationType,
  RuntimeConnection,
  type RuntimeTransport,
  type VersionSkewNotification,
} from "@commonfabric/runtime-client";
import type {
  IPCClientMessage,
  IPCRemoteMessage,
} from "@commonfabric/runtime-client";

/**
 * Tests that a versionSkew notification posted by the worker (when a space's
 * toolshed build differs from this client build) is demuxed by the connection
 * and re-emitted as a "versionskew" event the shell subscribes to.
 *
 * Worker: runtime.reportVersionSkew → postMessage(VersionSkewNotification)
 *   → RuntimeConnection._handleMessage → emit("versionskew")
 *   → RuntimeClient → lib-shell #onVersionSkew → shell banner
 */

type TransportEvents = { message: [IPCRemoteMessage] };

class MockTransport extends EventEmitter<TransportEvents>
  implements RuntimeTransport {
  send(_data: IPCClientMessage): void {}
  dispose(): Promise<void> {
    return Promise.resolve();
  }
  simulateMessage(msg: IPCRemoteMessage): void {
    this.emit("message", msg);
  }
}

describe("versionSkew IPC propagation", () => {
  it("re-emits a versionskew event with space and versions", () => {
    const transport = new MockTransport();
    const connection = new RuntimeConnection(transport);

    let received: VersionSkewNotification | null = null;
    connection.on("versionskew", (msg) => {
      received = msg;
    });

    transport.simulateMessage({
      type: NotificationType.VersionSkew,
      space: "did:key:z6Mktest",
      clientVersion: "client-sha",
      toolshedVersion: "toolshed-sha",
    });

    expect(received).not.toBeNull();
    expect(received!.space).toBe("did:key:z6Mktest");
    expect(received!.clientVersion).toBe("client-sha");
    expect(received!.toolshedVersion).toBe("toolshed-sha");
  });

  it("tolerates a versionskew with unknown (absent) versions", () => {
    const transport = new MockTransport();
    const connection = new RuntimeConnection(transport);

    let received: VersionSkewNotification | null = null;
    connection.on("versionskew", (msg) => {
      received = msg;
    });

    transport.simulateMessage({
      type: NotificationType.VersionSkew,
      space: "did:key:z6Mktest",
    });

    expect(received).not.toBeNull();
    expect(received!.clientVersion).toBeUndefined();
    expect(received!.toolshedVersion).toBeUndefined();
  });
});
