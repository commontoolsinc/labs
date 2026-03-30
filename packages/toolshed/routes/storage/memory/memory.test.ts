import { assert, assertEquals } from "@std/assert";
import env from "@/env.ts";
import app from "../../../app.ts";
import { refer } from "merkle-reference";
import {
  ChangesBuilder,
  CommitBuilder,
  Consumer,
  Fact,
  TransactionBuilder,
} from "@commonfabric/memory";
import * as Codec from "@commonfabric/memory/codec";
import * as Commit from "@commonfabric/memory/commit";
import { Identity } from "@commonfabric/identity";
import { bufferTextMessagesUntilNegotiated } from "./memory.handlers.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const the = "application/json";
const doc = `of:${refer({ hello: "world" })}` as const;

export const alice = await Identity.fromString(
  "MU+bzp2GaFQHso587iSFWPSeCzbSfn/CbNHEz7ilKRZ0=",
);

export const space = await Identity.fromString(
  "MCl6B1cu1ZOP0I3BBovjAqo57VImrMVyfLiSmNKoddXs=",
);

class FakeSocket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  closeCode?: number;
  closeReason?: string;

  send(_data: string): void {
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close"));
  }

  emitMessage(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

Deno.test("memory websocket negotiation handoff preserves buffered and live frames", async () => {
  const socket = new FakeSocket();
  const negotiation = bufferTextMessagesUntilNegotiated(
    socket as unknown as WebSocket,
  );

  socket.emitMessage("first");
  assertEquals(await negotiation.firstMessage, "first");

  socket.emitMessage("buffered-before-handoff");

  const received: string[] = [];
  negotiation.handoff({
    onMessage(message) {
      received.push(message);
    },
  });

  socket.emitMessage("after-handoff");

  assertEquals(received, [
    "buffered-before-handoff",
    "after-handoff",
  ]);
});

Deno.test("memory websocket negotiation closes when the buffered byte budget is exceeded", async () => {
  const socket = new FakeSocket();
  const negotiation = bufferTextMessagesUntilNegotiated(
    socket as unknown as WebSocket,
    { maxBufferedBytes: 4 },
  );

  socket.emitMessage("first");
  assertEquals(await negotiation.firstMessage, "first");

  socket.emitMessage("12345");

  assertEquals(socket.readyState, WebSocket.CLOSED);
  assertEquals(socket.closeCode, 1009);
  assertEquals(
    socket.closeReason,
    "Memory websocket negotiation buffer exceeded",
  );

  const errors: string[] = [];
  negotiation.handoff({
    onMessage() {
      throw new Error(
        "overflowed negotiation should not deliver buffered data",
      );
    },
    onError(error) {
      errors.push(error.message);
    },
  });

  assertEquals(errors, ["Memory websocket negotiation buffer exceeded"]);
});

Deno.test("test transaction", async () => {
  const server = Deno.serve({ port: 9000 }, app.fetch);
  const address = new URL(
    `http://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );

  try {
    const memory = Consumer.connect({
      address,
      as: space,
    });
    const home = memory.mount(space.did());

    const hello = Fact.assert({
      the,
      of: doc,
      is: { hello: "world" },
    });

    const transaction = TransactionBuilder.create({
      issuer: space.did(),
      subject: space.did(),
      changes: ChangesBuilder.from([hello]),
    });

    const result = await home.transact({
      changes: ChangesBuilder.from([hello]),
    });

    assertEquals(result, {
      ok: ChangesBuilder.from([
        CommitBuilder.create({
          space: space.did(),
          transaction,
        }),
      ]),
    });

    memory.close();
  } finally {
    await server.shutdown();
    Deno.removeSync(new URL(`./${space.did()}.sqlite`, env.MEMORY_DIR));
  }
});

Deno.test("test consumer", async () => {
  const server = Deno.serve({ port: 9000 }, app.fetch);
  const address = new URL(
    `http://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );
  try {
    const session = Consumer.connect({ address, as: alice });
    const memory = session.mount(alice.did());

    const result = await memory.query({
      select: {
        [doc]: {
          [the]: {},
        },
      },
    });

    assert(result.ok);
    const query = result.ok;
    assertEquals(query.facts, []);

    const subscription = query.subscribe();

    const fact = Fact.assert({ the, of: doc, is: { first: "doc" } });
    const tr = await memory.transact({
      changes: ChangesBuilder.from([fact]),
    });

    assert(tr.ok);
    const commit = Commit.toRevision(tr.ok);

    const message = await subscription.getReader().read();
    assertEquals(message.done, false);

    assertEquals(query.facts, [{ ...fact, since: commit.is.since }]);

    session.close();
  } finally {
    await server.shutdown();
    Deno.removeSync(new URL(`./${alice.did()}.sqlite`, env.MEMORY_DIR));
  }
});

Deno.test("memory websocket preserves early v1 frames during negotiation", async () => {
  const server = Deno.serve({ port: 9000 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );
  const docA = `of:${refer({ one: "a" })}` as const;
  const docB = `of:${refer({ two: "b" })}` as const;

  try {
    const consumer = Consumer.create({ as: alice });
    const memory = consumer.mount(alice.did());
    const invocations = consumer.readable.getReader();

    memory.query({
      select: {
        [docA]: {
          [the]: {},
        },
      },
    });
    memory.query({
      select: {
        [docB]: {
          [the]: {},
        },
      },
    });

    const first = await invocations.read();
    const second = await invocations.read();
    assert(!first.done);
    assert(!second.done);

    const socket = new WebSocket(address);
    const receipts: { the?: string }[] = [];
    const completion = Promise.withResolvers<void>();
    const timeout = setTimeout(() => {
      completion.reject(
        new Error("Timed out waiting for two v1 task/return receipts"),
      );
    }, 3_000);

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      const receipt = Codec.Receipt.fromString(event.data);
      receipts.push(receipt);
      const taskReturns = receipts.filter((entry) =>
        entry.the === "task/return"
      );
      if (taskReturns.length >= 2) {
        clearTimeout(timeout);
        completion.resolve();
      }
    });
    socket.addEventListener(
      "open",
      () => {
        socket.send(Codec.UCAN.toString(first.value));
        socket.send(Codec.UCAN.toString(second.value));
      },
      { once: true },
    );

    try {
      await completion.promise;
      assertEquals(
        receipts.filter((entry) => entry.the === "task/return").length,
        2,
      );
    } finally {
      consumer.close();
      socket.close();
    }
  } finally {
    await server.shutdown();
    try {
      Deno.removeSync(new URL(`./${alice.did()}.sqlite`, env.MEMORY_DIR));
    } catch (_error) {
      // Ignore missing sqlite cleanup in read-only websocket test.
    }
  }
});
