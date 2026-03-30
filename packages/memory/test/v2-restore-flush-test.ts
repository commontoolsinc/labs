import { assert, assertEquals } from "@std/assert";
import { Server } from "../v2/server.ts";
import { connect, type Transport } from "../v2/client.ts";

const SPACE = "did:key:z6Mk-restore-flush-test";

/**
 * Transport that wraps a real Server with lazy connection creation and
 * controlled disconnect/reconnect. Follows the same pattern as
 * ReconnectableLoopbackTransport in v2-client-test.ts.
 */
class ReconnectableTransport implements Transport {
  connectionCount = 0;
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<Server["connect"]> | null = null;
  #delayTransacts = false;
  #delayedTransacts: Array<{
    payload: string;
    resolve: () => void;
  }> = [];
  #deliveredTransactLocalSeqs: number[] = [];

  constructor(private readonly server: Server) {}

  async send(payload: string): Promise<void> {
    const message = JSON.parse(payload) as {
      type?: string;
      commit?: { localSeq?: number };
    };
    if (this.#delayTransacts && message.type === "transact") {
      return new Promise<void>((resolve) => {
        this.#delayedTransacts.push({ payload, resolve });
      });
    }
    await this.#deliver(payload);
  }

  close(): Promise<void> {
    this.disconnect();
    return Promise.resolve();
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  disconnect(): void {
    this.#connection?.close();
    this.#connection = null;
    queueMicrotask(() => this.#closeReceiver(new Error("disconnect")));
  }

  set delayTransacts(value: boolean) {
    this.#delayTransacts = value;
  }

  get pendingTransactCount(): number {
    return this.#delayedTransacts.length;
  }

  get delayedTransactLocalSeqs(): number[] {
    return this.#delayedTransacts.flatMap(({ payload }) => {
      const message = JSON.parse(payload) as { commit?: { localSeq?: number } };
      return typeof message.commit?.localSeq === "number"
        ? [message.commit.localSeq]
        : [];
    });
  }

  get deliveredTransactLocalSeqs(): number[] {
    return [...this.#deliveredTransactLocalSeqs];
  }

  async releaseTransacts(): Promise<void> {
    const delayed = this.#delayedTransacts.splice(0);
    for (const { payload, resolve } of delayed) {
      await this.#deliver(payload);
      resolve();
    }
  }

  async #deliver(payload: string): Promise<void> {
    const message = JSON.parse(payload) as { commit?: { localSeq?: number } };
    if (typeof message.commit?.localSeq === "number") {
      this.#deliveredTransactLocalSeqs.push(message.commit.localSeq);
    }
    await this.connection().receive(payload);
  }

  private connection(): ReturnType<Server["connect"]> {
    if (this.#connection === null) {
      this.connectionCount++;
      this.#connection = this.server.connect((message) => {
        this.#receiver(JSON.stringify(message));
      });
    }
    return this.#connection;
  }
}

const waitFor = async (
  predicate: () => boolean,
  timeout = 2000,
): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
};

Deno.test(
  "commits enqueued during restore are eventually flushed",
  async () => {
    const server = new Server({
      store: new URL("memory://restore-flush-test"),
    });

    const transport = new ReconnectableTransport(server);
    const client = await connect({ transport });
    const session = await client.mount(SPACE);
    const suppressDisconnectRejection = (event: PromiseRejectionEvent) => {
      if (
        event.reason instanceof Error &&
        event.reason.name === "ConnectionError" &&
        event.reason.message === "disconnect"
      ) {
        event.preventDefault();
      }
    };
    globalThis.addEventListener(
      "unhandledrejection",
      suppressDisconnectRejection,
    );

    try {
      // Seed doc:a.
      await session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "doc:a", value: { value: { v: 1 } } }],
      });

      // Hold transact responses so we can enqueue during the replay window.
      transport.delayTransacts = true;

      // Start commit B — it will be held at the transport layer.
      const commitBPromise = session.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "doc:b", value: { value: { v: 2 } } }],
      });

      // Wait for the transact to reach the transport.
      await waitFor(() => transport.pendingTransactCount >= 1);
      assertEquals(transport.delayedTransactLocalSeqs, [2]);

      // Disconnect while commit B's transact is held — commit B becomes
      // outstanding and will be replayed during restore.
      transport.disconnect();

      // While the replay transact is held (and #restoring is true),
      // enqueue commit C.
      const commitCPromise = session.transact({
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "doc:c", value: { value: { v: 3 } } }],
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert(
        !transport.delayedTransactLocalSeqs.includes(3),
        "commit C should wait for restore to finish instead of sending during replay",
      );

      // Release all delayed transacts.
      transport.delayTransacts = false;
      await transport.releaseTransacts();

      // Both commits should resolve.
      let timeoutId: ReturnType<typeof setTimeout>;
      const timeout = new Promise<"timeout">((resolve) => {
        timeoutId = setTimeout(() => resolve("timeout"), 5000);
      });

      const result = await Promise.race([
        Promise.all([commitBPromise, commitCPromise]).then(
          () => "resolved" as const,
        ).catch((e) => `error:${e.message}` as const),
        timeout,
      ]);
      clearTimeout(timeoutId!);

      assert(
        result === "resolved",
        `Commits enqueued during restore should flush, but got: ${result}`,
      );

      const queried = await session.queryGraph({
        roots: [
          { id: "doc:b", selector: { path: [], schema: false } },
          { id: "doc:c", selector: { path: [], schema: false } },
        ],
      });
      assertEquals(
        Object.fromEntries(
          queried.entities.map((entity) => [entity.id, entity.document?.value]),
        ),
        {
          "doc:b": { v: 2 },
          "doc:c": { v: 3 },
        },
      );
      assertEquals(
        transport.deliveredTransactLocalSeqs.filter((localSeq) =>
          localSeq === 3
        )
          .length,
        1,
      );
      assertEquals(transport.deliveredTransactLocalSeqs.at(-1), 3);
      assertEquals(transport.connectionCount, 2);
    } finally {
      globalThis.removeEventListener(
        "unhandledrejection",
        suppressDisconnectRejection,
      );
      await client.close();
      await server.flushSessions();
      await server.close();
    }
  },
);
