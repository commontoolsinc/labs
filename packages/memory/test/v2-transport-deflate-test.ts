import { describe, it } from "@std/testing/bdd";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  deflateWirePayload,
  inflateWirePayload,
  MEMORY_WS_DEFLATE_SUBPROTOCOL,
  selectMemoryWsDeflateProtocol,
  SerialTaskQueue,
} from "../v2/transport-deflate.ts";

describe("memory ws deflate codec", () => {
  it("roundtrips wire payloads through raw deflate", async () => {
    const payloads = [
      "fvj1:{}",
      "fvj1:" + JSON.stringify({
        type: "sync",
        upserts: Array.from({ length: 64 }, (_, i) => ({
          id: `of:entity-${i}`,
          doc: { value: { n: i, text: "x".repeat(200) } },
        })),
      }),
      "fvj1:" + JSON.stringify({ unicode: "snowman ☃ και ελληνικά 🎿" }),
    ];
    for (const payload of payloads) {
      const compressed = await deflateWirePayload(payload);
      assertEquals(await inflateWirePayload(compressed), payload);
    }
  });

  it("compresses repetitive protocol payloads well", async () => {
    const payload = "fvj1:" + JSON.stringify({
      upserts: Array.from({ length: 100 }, (_, i) => ({
        id: "of:did:key:z6MkjJcyGFU2QkPjvzuWUHr59i112SkPBkXQo2TVdWLPUdKB",
        seq: i,
        doc: { value: { schema: { type: "object" } } },
      })),
    });
    const originalBytes = new TextEncoder().encode(payload).byteLength;
    const compressed = await deflateWirePayload(payload);
    assert(
      compressed.byteLength < originalBytes / 4,
      `expected >4x compression, got ${originalBytes} -> ${compressed.byteLength}`,
    );
  });

  it("accepts typed-array views over the compressed bytes", async () => {
    const payload = "fvj1:" + JSON.stringify({ hello: "world".repeat(50) });
    const compressed = await deflateWirePayload(payload);
    const padded = new Uint8Array(compressed.byteLength + 8);
    padded.set(compressed, 4);
    const view = new Uint8Array(padded.buffer, 4, compressed.byteLength);
    assertEquals(await inflateWirePayload(view), payload);
  });

  it("rejects malformed deflate data", async () => {
    await assertRejects(() =>
      inflateWirePayload(new Uint8Array([1, 2, 3, 4, 5]))
    );
  });

  it("rejects payloads that inflate past the cap", async () => {
    const bomb = await deflateWirePayload("z".repeat(1024 * 1024));
    await assertRejects(
      () => inflateWirePayload(bomb, 64 * 1024),
      Error,
      "inflates past",
    );
  });

  it("rejects compressed frames that decode to invalid UTF-8", async () => {
    // Compress raw bytes that are not valid UTF-8 (lone continuation bytes).
    const invalid = new Uint8Array(1024).fill(0x80);
    const stream = new Blob([invalid]).stream()
      .pipeThrough(new CompressionStream("deflate-raw"));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    await assertRejects(() => inflateWirePayload(compressed));
  });
});

describe("memory ws deflate subprotocol selection", () => {
  it("selects the subprotocol whenever it is offered", () => {
    assertEquals(
      selectMemoryWsDeflateProtocol(MEMORY_WS_DEFLATE_SUBPROTOCOL),
      MEMORY_WS_DEFLATE_SUBPROTOCOL,
    );
    assertEquals(
      selectMemoryWsDeflateProtocol(
        `other.protocol, ${MEMORY_WS_DEFLATE_SUBPROTOCOL}`,
      ),
      MEMORY_WS_DEFLATE_SUBPROTOCOL,
    );
    assertEquals(selectMemoryWsDeflateProtocol(null), undefined);
    assertEquals(selectMemoryWsDeflateProtocol(undefined), undefined);
    assertEquals(selectMemoryWsDeflateProtocol("other.protocol"), undefined);
  });

  it("does not match substrings of other offered protocols", () => {
    assertEquals(
      selectMemoryWsDeflateProtocol(
        `${MEMORY_WS_DEFLATE_SUBPROTOCOL}-extended`,
      ),
      undefined,
    );
  });
});

describe("memory ws deflate serial queue", () => {
  it("runs tasks in enqueue order despite varying latency", async () => {
    const queue = new SerialTaskQueue();
    const order: number[] = [];
    const tasks = [
      queue.enqueue(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push(1);
      }),
      queue.enqueue(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        order.push(2);
      }),
      queue.enqueue(() => {
        order.push(3);
      }),
    ];
    await Promise.all(tasks);
    assertEquals(order, [1, 2, 3]);
  });

  it("propagates a task failure to its caller without poisoning the chain", async () => {
    const queue = new SerialTaskQueue();
    const order: string[] = [];
    const failing = queue.enqueue(() => {
      throw new Error("boom");
    });
    const after = queue.enqueue(() => {
      order.push("after");
      return "ok";
    });
    await assertRejects(() => failing, Error, "boom");
    assertEquals(await after, "ok");
    assertEquals(order, ["after"]);
  });
});
