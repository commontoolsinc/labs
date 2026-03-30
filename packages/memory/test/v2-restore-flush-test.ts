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

  constructor(private readonly server: Server) {}

  async send(payload: string): Promise<void> {
    const message = JSON.parse(payload) as { type?: string };
    if (this.#delayTransacts && message.type === "transact") {
      return new Promise<void>((resolve) => {
        this.#delayedTransacts.push({ payload, resolve });
      });
    }
    await this.connection().receive(payload);
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
    this.#closeReceiver(new Error("disconnect"));
  }

  set delayTransacts(value: boolean) {
    this.#delayTransacts = value;
  }

  get pendingTransactCount(): number {
    return this.#delayedTransacts.length;
  }

  async releaseTransacts(): Promise<void> {
    const delayed = this.#delayedTransacts.splice(0);
    for (const { payload, resolve } of delayed) {
      await this.connection().receive(payload);
      resolve();
    }
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

      // Disconnect while commit B's transact is held — commit B becomes
      // outstanding and will be replayed during restore.
      transport.disconnect();

      // Wait for reconnect to start and the replay transact to arrive.
      await waitFor(() => transport.pendingTransactCount >= 1);

      // While the replay transact is held (and #restoring is true),
      // enqueue commit C.
      const commitCPromise = session.transact({
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "doc:c", value: { value: { v: 3 } } }],
      });

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

      // Verify both docs were written.
      assertEquals(transport.connectionCount, 2);
    } finally {
      await client.close();
      await server.flushSessions();
      await server.close();
    }
  },
);
