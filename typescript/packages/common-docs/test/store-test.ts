import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import * as Repository from "../store.ts";
import { refer } from "merkle-reference";
import { createTemporaryDirectory } from "../util.js";

const alice = "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi";
const doc = "4301a667-5388-4477-ba08-d2e6b51a62a3";

const base = refer({ is: { this: doc } }).toString();

const repo = new URL(
  "file:///Users/gozala/Projects/labs/typescript/packages/common-docs/test2.sqlite",
);

const test = (
  title: string,
  url: URL,
  run: (replica: Repository.Store) => Promise<unknown>,
) =>
  Deno.test(title, async () => {
    const session = await Repository.open({
      url,
    });

    assert(session.ok, "Open create repository if it does not exist");

    try {
      await run(session.ok);
    } finally {
      await Repository.close(session.ok);
    }
  });

test(
  "non existing document returns implicit one",
  new URL(`memory:${alice}`),
  async session => {
    assertEquals(await Repository.query(session, { this: doc }), {
      ok: {
        of: doc,
        is: { this: doc },
      },
    });
  },
);

test("create new document", new URL(`memory:${alice}`), async session => {
  const result = await Repository.assert(session, {
    of: doc,
    is: { v: 1 },
  });

  assertEquals(result, {
    ok: {
      at: session.id,
      of: doc,
      is: refer({
        is: { v: 1 },
        was: base,
      }).toString(),
      was: base,
    },
  });

  const { ok: found } = Repository.query(session, { this: doc });

  assertEquals(found, {
    of: doc,
    is: { v: 1 },
    was: base,
  });
});

test("update document", new URL(`memory:${alice}`), async session => {
  const create = await Repository.assert(session, {
    of: doc,
    is: { v: 0 },
    was: base,
  });

  assert(create.ok, "Document asserted");

  const v0 = refer({ is: { v: 0 }, was: base }).toString();

  const update = await Repository.assert(session, {
    of: doc,
    is: { v: 1 },
    was: v0,
  });

  const v1 = refer({ is: { v: 1 }, was: v0 }).toString();

  assertEquals(
    update,
    {
      ok: {
        at: alice,
        of: doc,
        was: v0,
        is: v1,
      },
    },
    "updates document",
  );
});

test(
  "assertion fails if expected document does not exist",
  new URL(`memory:${alice}`),
  async session => {
    const v0 = refer({ is: { v: 0 }, was: base }).toString();

    const result = await Repository.assert(session, {
      of: doc,
      is: { v: 1 },
      was: v0,
    });

    assert(result.error, "Update should fail if document does not exists");
    assertEquals(result.error?.name, "ConflictError");
    assertEquals(result.error?.at, alice);
    assertEquals(result.error?.of, doc);
    assertEquals(result.error?.expected, v0);
    assertEquals(result.error?.actual, {
      is: { this: doc },
    });
  },
);

test(
  "assertion fails if unexpected document exists",
  new URL(`memory:${alice}`),
  async session => {
    const create = await Repository.assert(session, {
      of: doc,
      is: { v: 0 },
    });

    assert(create.ok, "Document created");

    const conflict = await Repository.assert(session, {
      of: doc,
      is: { v: 1 },
    });

    assert(conflict.error, "Update should fail if document does not exists");
    assertEquals(conflict.error?.name, "ConflictError");
    assertEquals(conflict.error?.expected, base);
    assertEquals(conflict.error?.actual, {
      is: { v: 0 },
      was: base,
    });
  },
);

test(
  "concurrent assertion fails",
  new URL(`memory:${alice}`),
  async session => {
    const a = await Repository.assert(session, {
      of: doc,
      is: { a: true },
    });

    const b = await Repository.assert(session, {
      of: doc,
      is: { b: true },
    });

    assert(a.ok, "Document created");

    assert(b.error, "Concurrent creation  was rejected");

    assertEquals(b.error.name, "ConflictError");
    assertEquals(b.error.of, doc);
    assertEquals(b.error.expected, base);
    assertEquals(b.error.actual, {
      is: { a: true },
      was: base,
    });
  },
);

test("create implicit document", new URL(`memory:${alice}`), async session => {
  const result = await Repository.assert(session, {
    of: doc,
    is: { this: doc },
  });

  assertEquals(result, {
    ok: {
      at: alice,
      of: doc,
      was: base,
      is: refer({ is: { this: doc }, was: base }).toString(),
    },
  });
});

// test("redundant assertion", new URL(`memory:${alice}`), async session => {
//   const result = await Repository.assert(session, {
//     of: doc,
//     is: { v: 5 },
//     was: Repository.IMPLICIT,
//   });

//   assert(result.ok, "Document created");

//   const noop = await Repository.assert(session, {
//     of: doc,
//     is: { v: 5 },
//     was: { "#": refer({ v: 5 }).toString() },
//   });

//   assertEquals(
//     noop,
//     {
//       ok: {
//         at: alice,
//         of: doc,
//         was: { "#": refer({ v: 5 }).toString() },
//         is: { "#": refer({ v: 5 }).toString() },
//       },
//     },
//     "redundant assertion",
//   );
// });

test("retract document", new URL(`memory:${alice}`), async session => {
  const create = await Repository.assert(session, {
    of: doc,
    is: { v: 0 },
  });

  assert(create.ok, "Document created");
  assertEquals(await session.query({ this: doc }), {
    ok: {
      of: doc,
      is: { v: 0 },
      was: base,
    },
  });

  const result = session.transact({
    retract: {
      of: doc,
      is: refer({ is: { v: 0 }, was: base }).toString(),
    },
  });

  assertEquals(result, {
    ok: {
      at: alice,
      of: doc,
      was: refer({ is: { v: 0 }, was: base }).toString(),
      is: base,
    },
  });

  assertEquals(await session.query({ this: doc }), {
    ok: {
      of: doc,
      is: { this: doc },
    },
  });
});

test(
  "fails to retract if expected version is out of date",
  new URL(`memory:${alice}`),
  async session => {
    const v5 = await Repository.assert(session, {
      of: doc,
      is: { v: 5 },
    });

    assert(v5.ok, "Document created");

    const result = session.transact({
      retract: {
        of: doc,
        is: refer({ is: { v: 3 }, was: base }).toString(),
      },
    });

    assert(result.error, "Retract fails if expected version is out of date");
    assertEquals(result.error?.name, "ConflictError");
    assertEquals(
      result.error?.expected,
      refer({ is: { v: 3 }, was: base }).toString(),
    );
    assertEquals(result.error?.actual, {
      is: { v: 5 },
      was: base,
    });
    assertMatch(
      result.error.message,
      RegExp(
        `Document ${doc} at ${alice} was expected to be ${refer({ is: { v: 3 }, was: base })} instead of actual ${refer({ is: { v: 5 }, was: base })}`,
      ),
    );
  },
);

Deno.test("fail to connect to non-existing replica", async () => {
  const url = new URL(`./${alice}.sqlite`, await createTemporaryDirectory());
  const session = await Repository.connect({ url });

  await assert(session.error, "Replica does not exist");

  if (session.error) {
    assertEquals(session.error.name, "ReplicaNotFound");
    assertEquals(session.error.replica, alice);
  }
});

Deno.test("open creates replica if does not exists", async () => {
  const url = new URL(`./${alice}.sqlite`, await createTemporaryDirectory());

  try {
    const open = await Repository.open({
      url,
    });

    await assert(open.ok, "Opened a repository");

    const session = open.ok as Repository.Store;
    const create = await Repository.assert(session, {
      of: doc,
      is: { v: 0 },
    });

    assertEquals(
      create,
      {
        ok: {
          at: alice,
          of: doc,
          was: base,
          is: refer({ is: { v: 0 }, was: base }).toString(),
        },
      },
      "created document",
    );

    const select = Repository.query(session, { this: doc });
    assertEquals(select.ok, {
      of: doc,
      is: { v: 0 },
      was: base,
    });
  } finally {
    await Deno.remove(url);
  }
});
