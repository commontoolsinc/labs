import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { RuntimeConnection } from "./client/connection.ts";
import { EventEmitter } from "./client/emitter.ts";
import {
  type InitializationData,
  type IPCClientMessage,
  RequestType,
} from "./protocol/mod.ts";
import type {
  RuntimeTransport,
  RuntimeTransportEvents,
} from "./client/transport.ts";

type ReplyBehavior = "ack" | "error" | "hold";

/**
 * Transport whose reply to each request type is configurable: acknowledge with
 * a success response (the default), reply with an error response, or hold the
 * request pending so it never settles on its own. Records the type of every
 * sent request so a test can assert what was, or was not, sent.
 */
class ConfigurableTransport extends EventEmitter<RuntimeTransportEvents>
  implements RuntimeTransport {
  readonly sent: RequestType[] = [];

  constructor(
    private behavior: Partial<Record<RequestType, ReplyBehavior>> = {},
    private errorMessage = "ack rejected for test",
  ) {
    super();
  }

  send(message: IPCClientMessage): void {
    this.sent.push(message.data.type);
    const behavior = this.behavior[message.data.type] ?? "ack";
    if (behavior === "hold") return;
    // Reply asynchronously, like a real worker round-trip.
    queueMicrotask(() => {
      if (behavior === "error") {
        this.emit("message", {
          msgId: message.msgId,
          error: this.errorMessage,
        });
      } else {
        this.emit("message", { msgId: message.msgId, data: undefined });
      }
    });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

async function initializedConnection(
  transport: RuntimeTransport,
): Promise<RuntimeConnection> {
  const connection = new RuntimeConnection(transport);
  await connection.initialize({} as InitializationData);
  return connection;
}

/** Drain the microtask queue so transport replies and `.catch` handlers run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("RuntimeConnection.ackVDomBatch", () => {
  it("logs when the acknowledgement request rejects with a non-disposed error", async () => {
    const transport = new ConfigurableTransport({
      [RequestType.VDomBatchApplied]: "error",
    });
    const connection = await initializedConnection(transport);
    const error = stub(console, "error", () => {});
    try {
      connection.ackVDomBatch(1, 2);
      await flushMicrotasks();

      expect(error.calls.length).toBe(1);
      expect(error.calls[0].args[0]).toBe(
        "[RuntimeClient] VDom batch acknowledgement failed:",
      );
    } finally {
      error.restore();
      await connection.dispose();
    }
  });

  it("swallows a runtime-disposed rejection from the acknowledgement", async () => {
    const transport = new ConfigurableTransport({
      [RequestType.VDomBatchApplied]: "hold",
    });
    const connection = await initializedConnection(transport);
    const error = stub(console, "error", () => {});
    try {
      // The request is held pending; disposing rejects it with a
      // RuntimeDisposedError, which the handler must swallow.
      connection.ackVDomBatch(1, 2);
      await connection.dispose();
      await flushMicrotasks();

      expect(error.calls.length).toBe(0);
    } finally {
      error.restore();
    }
  });

  it("does not send an acknowledgement once disposed", async () => {
    const transport = new ConfigurableTransport();
    const connection = await initializedConnection(transport);
    await connection.dispose();

    const sentBefore = transport.sent.length;
    connection.ackVDomBatch(1, 2);

    expect(transport.sent.length).toBe(sentBefore);
    expect(transport.sent).not.toContain(RequestType.VDomBatchApplied);
  });
});
