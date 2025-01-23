import { assert, assertEquals } from "jsr:@std/assert";
import * as Replica from "../replica.ts";
import { refer } from "merkle-reference";
import { createTemporaryDirectory } from "../util.js";

const alice = "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi";
const doc = "4301a667-5388-4477-ba08-d2e6b51a62a3";

const test = (
  title: string,
  url: URL,
  run: (replica: Replica.Replica) => Promise<unknown>,
) =>
  Deno.test(title, async () => {
    const connection = await Replica.open({
      url,
      pool: new Map(),
    });

    assert(connection.ok, "Replica should be created and connected");
    await run(connection.ok);
  });

test("create document", new URL(`memory:${alice}`), async replica => {
  const { error: notFound } = Replica.select(replica, { entity: doc });
  assertEquals(notFound?.name, "EntityNotFound");
  assertEquals(notFound?.replica, alice);
  assertEquals(notFound?.entity, doc);

  const { ok: create } = await Replica.assert(replica, {
    entity: doc,
    value: {},
    as: refer({}).toString(),
  });

  assertEquals(
    create,
    {
      replica: alice,
      entity: doc,
      version: refer({}).toString(),
    },
    "created document",
  );

  const { ok: found } = Replica.select(replica, { entity: doc });
  assertEquals(found, {
    replica: alice,
    entity: doc,
    value: {},
    version: refer({}).toString(),
  });

  await Replica.close(replica);
});

test("update document", new URL(`memory:${alice}`), async replica => {
  const create = await Replica.assert(replica, {
    entity: doc,
    value: { v: 0 },
    as: refer({ v: 0 }).toString(),
  });

  assert(create.ok, "Document created");

  assertEquals(await Replica.select(replica, { entity: doc }), {
    ok: {
      replica: alice,
      entity: doc,
      value: { v: 0 },
      version: refer({ v: 0 }).toString(),
    },
  });

  const update = await Replica.assert(replica, {
    entity: doc,
    version: refer({ v: 0 }).toString(),
    value: { v: 1 },
    as: refer({ v: 1 }).toString(),
  });

  assertEquals(
    update,
    {
      ok: {
        replica: alice,
        entity: doc,
        version: refer({ v: 1 }).toString(),
      },
    },
    "updated document",
  );
});

test(
  "fail to update non-existing document",
  new URL(`memory:${alice}`),
  async replica => {
    const update = await Replica.assert(replica, {
      entity: doc,
      version: refer({ v: 0 }).toString(),
      value: { v: 1 },
      as: refer({ v: 1 }).toString(),
    });

    assert(update.error, "Update should fail if document does not exists");
    assertEquals(update.error?.name, "EntityNotFound");
    assertEquals(update.error?.replica, alice);
    assertEquals(update.error?.entity, doc);
  },
);

test(
  "fail to update on version conflict",
  new URL(`memory:${alice}`),
  async replica => {
    const create = await Replica.assert(replica, {
      entity: doc,
      value: { v: 0 },
      as: refer({ v: 0 }).toString(),
    });

    assert(create.ok, "Document created");

    const update = await Replica.assert(replica, {
      entity: doc,
      version: refer({ v: 1 }).toString(),
      value: { v: 2 },
      as: refer({ v: 2 }).toString(),
    });

    assert(update.error, "Update should fail on version conflict");
    assertEquals(update.error?.name, "ConflictError");

    if (update.error.name === "ConflictError") {
      assertEquals(update.error?.replica, alice);
      assertEquals(update.error?.entity, doc);
      assertEquals(update.error?.expected, refer({ v: 1 }).toString());
      assertEquals(update.error?.actual, refer({ v: 0 }).toString());
      assertEquals(update.error?.value, { v: 0 });
    }
  },
);

Deno.test("fail to connect to non-existing replica", async () => {
  const url = new URL(`./${alice}.sqlite`, await createTemporaryDirectory());
  const connection = await Replica.connect({
    url,
    pool: new Map(),
  });

  await assert(connection.error, "Replica does not exist");

  if (connection.error) {
    assertEquals(connection.error.name, "ReplicaNotFound");
    assertEquals(connection.error.replica, alice);
  }
});

Deno.test("open creates replica if does not exists", async () => {
  const url = new URL(`./${alice}.sqlite`, await createTemporaryDirectory());
  try {
    const connection = await Replica.open({
      url,
      pool: new Map(),
    });

    await assert(connection.ok, "Replica was created");

    const replica = connection.ok as Replica.Replica;
    const { ok: create } = await Replica.assert(replica, {
      entity: doc,
      value: {},
      as: refer({}).toString(),
    });

    assertEquals(
      create,
      {
        replica: alice,
        entity: doc,
        version: refer({}).toString(),
      },
      "created document",
    );

    const select = Replica.select(replica, { entity: doc });
    assertEquals(select.ok, {
      replica: alice,
      entity: doc,
      value: {},
      version: refer({}).toString(),
    });
  } finally {
    await Deno.remove(url);
  }
});
