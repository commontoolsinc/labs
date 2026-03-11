import { assertEquals } from "@std/assert";
import { Server } from "../v2/server.ts";
import { connect, loopback } from "../v2/client.ts";

Deno.test("memory v2 client transacts and receives graph subscription updates", async () => {
  const server = new Server({
    store: new URL("memory://memory-v2-client"),
  });
  const client = await connect({
    transport: loopback(server),
  });
  const space = await client.mount("did:key:z6Mk-memory-v2-client");

  const view = await space.queryGraph({
    subscribe: true,
    roots: [{
      id: "of:doc:1",
      selector: {
        path: [],
        schema: false,
      },
    }],
  });

  assertEquals(view.entities.map((entity: any) => ({
    id: entity.id,
    seq: entity.seq,
    document: entity.document,
  })), [{
    id: "of:doc:1",
    seq: 0,
    document: null,
  }]);

  const updates = view.subscribe();
  const pending = updates.next();

  const commit = await space.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: "of:doc:1",
      value: {
        value: {
          hello: "client",
        },
      },
    }],
  });

  assertEquals(commit.seq, 1);

  const update = await pending;
  assertEquals(update.done, false);
  assertEquals(update.value.entities.map((entity: any) => ({
    id: entity.id,
    seq: entity.seq,
    document: entity.document,
  })), [{
    id: "of:doc:1",
    seq: 1,
    document: {
      value: {
        hello: "client",
      },
    },
  }]);

  await client.close();
  await server.close();
});
