import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { RuntimeConnection } from "./connection.ts";
import { EventEmitter } from "./emitter.ts";
import { isRuntimeDisposedError } from "../shared/disposed-error.ts";
import {
  type InitializationData,
  type IPCClientMessage,
  RequestType,
} from "../protocol/mod.ts";
import type { RuntimeTransport, RuntimeTransportEvents } from "./transport.ts";

/**
 * Transport that auto-acknowledges every request except the types in
 * `holdTypes`, which are left pending (simulating in-flight work).
 */
class FakeTransport extends EventEmitter<RuntimeTransportEvents>
  implements RuntimeTransport {
  constructor(private holdTypes: RequestType[] = []) {
    super();
  }

  send(message: IPCClientMessage): void {
    if (this.holdTypes.includes(message.data.type)) return;
    // Acknowledge asynchronously, like a real worker round-trip.
    queueMicrotask(() => {
      this.emit("message", { msgId: message.msgId, data: undefined });
    });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

async function initializedConnection(
  transport: FakeTransport,
): Promise<RuntimeConnection> {
  const connection = new RuntimeConnection(transport);
  await connection.initialize({} as InitializationData);
  return connection;
}

describe("RuntimeConnection disposal", () => {
  it("rejects in-flight requests with RuntimeDisposedError on dispose", async () => {
    const transport = new FakeTransport([RequestType.Idle]);
    const connection = await initializedConnection(transport);

    const inFlight = connection.request<RequestType.Idle>({
      type: RequestType.Idle,
    });
    // Avoid an unhandled rejection between dispose() and the assertion.
    const settled = inFlight.then(() => undefined, (error) => error);

    await connection.dispose();

    const error = await settled;
    expect(isRuntimeDisposedError(error)).toBe(true);
  });

  it("rejects requests issued after dispose with RuntimeDisposedError", async () => {
    const transport = new FakeTransport();
    const connection = await initializedConnection(transport);
    await connection.dispose();

    const error = await connection
      .request<RequestType.Idle>({ type: RequestType.Idle })
      .then(() => undefined, (e) => e);
    expect(isRuntimeDisposedError(error)).toBe(true);
  });
});
