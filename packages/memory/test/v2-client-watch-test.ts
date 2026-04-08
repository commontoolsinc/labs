import { assertEquals } from "@std/assert";
import { Server } from "../v2/server.ts";
import { connect, loopback } from "../v2/client.ts";
import type { EntitySnapshot } from "../v2.ts";

Deno.test("memory v2 client installs a watch set and receives live updates", async () => {
  const server = new Server({
    store: new URL("memory://memory-v2-client-watch"),
    subscriptionRefreshDelayMs: 0,
  });
  const writerClient = await connect({
    transport: loopback(server),
  });
  const watcherClient = await connect({
    transport: loopback(server),
  });
  const space = "did:key:z6Mk-memory-v2-client-watch";
  const writer = await writerClient.mount(space);
  const watcher = await watcherClient.mount(space);

  try {
    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:1",
        value: {
          value: {
            hello: "world",
          },
        },
      }],
    });

    const view = await watcher.watchSet([{
      id: "root",
      kind: "graph",
      query: {
        roots: [{
          id: "of:doc:1",
          selector: {
            path: [],
            schema: false,
          },
        }],
      },
    }]);

    assertEquals(
      view.entities.map((entity: EntitySnapshot) => ({
        branch: entity.branch,
        id: entity.id,
        seq: entity.seq,
        document: entity.document,
      })),
      [{
        branch: "",
        id: "of:doc:1",
        seq: 1,
        document: {
          value: {
            hello: "world",
          },
        },
      }],
    );

    const updates = view.subscribe();
    const pending = updates.next();
    await writer.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:1",
        value: {
          value: {
            hello: "again",
          },
        },
      }],
    });

    const next = await pending;
    assertEquals(next.done, false);
    assertEquals(
      next.value.entities.map((entity: EntitySnapshot) => ({
        branch: entity.branch,
        id: entity.id,
        seq: entity.seq,
        document: entity.document,
      })),
      [{
        branch: "",
        id: "of:doc:1",
        seq: 2,
        document: {
          value: {
            hello: "again",
          },
        },
      }],
    );
  } finally {
    await writerClient.close();
    await watcherClient.close();
    await server.close();
  }
});
