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
  "error when querying non existing",
  new URL(`memory:${alice}`),
  async session => {
    const result = await Repository.query(session, {
      the: "application/json",
      of: doc,
    });

    assert(result.error, "Document does not exist");
    assert(result.error.name === "MemoryNotFound");
    assertEquals(result.error.in, alice);
    assertEquals(result.error.the, "application/json");
    assertEquals(result.error.of, doc);
  },
);

test("create new fact", new URL(`memory:${alice}`), async session => {
  const result = await Repository.assert(session, {
    the: "application/json",
    of: doc,
    is: { v: 1 },
  });

  assertEquals(result, {
    ok: {
      in: session.id,
      the: "application/json",
      of: doc,
      is: refer({ v: 1 }),
    },
  });

  const { ok: found } = Repository.query(session, {
    the: "application/json",
    of: doc,
  });

  assertEquals(found, {
    the: "application/json",
    of: doc,
    is: { v: 1 },
  });
});

test("updates fact", new URL(`memory:${alice}`), async session => {
  const v0 = {
    the: "application/json",
    of: doc,
    is: { v: 0 },
  };

  const create = await Repository.assert(session, v0);

  assert(create.ok, "Document asserted");
  assertEquals(create, {
    ok: {
      in: alice,
      the: "application/json",
      of: doc,
      is: refer({ v: 0 }),
    },
  });

  const update = await Repository.assert(session, {
    the: "application/json",
    of: doc,
    is: { v: 1 },
    cause: refer(v0),
  });

  assertEquals(
    update,
    {
      ok: {
        in: alice,
        the: "application/json",
        of: doc,
        is: refer({ v: 1 }),
        cause: refer(v0),
      },
    },
    "updates document",
  );
});

test(
  "fails updating non-existing",
  new URL(`memory:${alice}`),
  async session => {
    const v1 = {
      the: "application/json",
      of: doc,
      is: { v: 2 },
    };

    const result = await Repository.assert(session, {
      the: "application/json",
      of: doc,
      is: { v: 2 },
      cause: refer(v1),
    });

    assert(result.error, "Update should fail if document does not exists");
    assert(result.error.name === "ConflictError");
    assertEquals(result.error.in, alice);
    assertEquals(result.error.of, doc);
    assertEquals(result.error.expected, refer(v1));
    assertEquals(result.error.actual, null);
  },
);

test("create fails when exists", new URL(`memory:${alice}`), async session => {
  const create = await Repository.assert(session, {
    the: "application/json",
    of: doc,
    is: { v: 0 },
  });

  assert(create.ok, "Document created");

  const conflict = await Repository.assert(session, {
    the: "application/json",
    of: doc,
    is: { v: 1 },
  });

  assert(conflict.error, "Create fail when already exists");
  assert(conflict.error.name === "ConflictError");
  assertEquals(conflict.error.expected, null);
  assertEquals(conflict.error?.actual, {
    the: "application/json",
    of: doc,
    is: { v: 0 },
  });
});

test("concurrent update fails", new URL(`memory:${alice}`), async session => {
  const base = {
    the: "application/json",
    of: doc,
    is: {},
  };

  assert(await Repository.assert(session, base).ok);

  const a = await Repository.assert(session, {
    the: "application/json",
    of: doc,
    is: { a: true },
    cause: refer(base),
  });

  const b = await Repository.assert(session, {
    the: "application/json",
    of: doc,
    is: { b: true },
    cause: refer(base),
  });

  assertEquals(a.ok, {
    in: alice,
    the: "application/json",
    of: doc,
    is: refer({ a: true }),
    cause: refer(base),
  });

  assert(b.error, "Concurrent update was rejected");
  assert(b.error.name === "ConflictError");
  assertEquals(b.error.of, doc);
  assertEquals(b.error.expected, refer(base));
  assertEquals(b.error.actual, {
    the: "application/json",
    of: doc,
    is: { a: true },
    cause: refer(base),
  });
});

test(
  "concurrent identical creates succeed",
  new URL(`memory:${alice}`),
  async session => {
    const result = await Repository.assert(session, {
      the: "application/json",
      of: doc,
      is: { this: doc },
    });

    assertEquals(result, {
      ok: {
        in: alice,
        the: "application/json",
        of: doc,
        is: refer({ this: doc }),
      },
    });

    const update = await Repository.assert(session, {
      the: "application/json",
      of: doc,
      is: { this: doc },
    });

    assertEquals(update, {
      ok: {
        in: alice,
        the: "application/json",
        of: doc,
        is: refer({ this: doc }),
      },
    });
  },
);

test(
  "concurrent identical updates succeed",
  new URL(`memory:${alice}`),
  async session => {
    const v0 = {
      the: "application/json",
      of: doc,
      is: { v: 0 },
    };

    assert(await Repository.assert(session, v0).ok);

    const first = await Repository.assert(session, {
      the: "application/json",
      of: doc,
      is: { v: 1 },
      cause: refer(v0),
    });

    assertEquals(first, {
      ok: {
        in: alice,
        the: "application/json",
        of: doc,
        is: refer({ v: 1 }),
        cause: refer(v0),
      },
    });

    const second = await Repository.assert(session, {
      the: "application/json",
      of: doc,
      is: { v: 1 },
      cause: refer(v0),
    });

    assertEquals(second, {
      ok: {
        in: alice,
        the: "application/json",
        of: doc,
        is: refer({ v: 1 }),
        cause: refer(v0),
      },
    });
  },
);

test("retract document", new URL(`memory:${alice}`), async session => {
  const create = await Repository.assert(session, {
    the: "application/json",
    of: doc,
    is: { v: 0 },
  });

  assert(create.ok, "Document created");
  assertEquals(await session.query({ the: "application/json", of: doc }), {
    ok: {
      the: "application/json",
      of: doc,
      is: { v: 0 },
    },
  });

  const drop = session.transact({
    retract: {
      the: "application/json",
      of: doc,
      is: refer({ v: 0 }),
    },
  });

  assert(drop.ok, "Document retracted");

  // assertEquals(result, {
  //   ok: {
  //     at: alice,
  //     of: doc,
  //     was: refer({ is: { v: 0 }, was: base }).toString(),
  //     is: base,
  //   },
  // });

  const read = await session.query({ the: "application/json", of: doc });
  assert(read.error, "Memory was retracted");
  assert(read.error.name === "MemoryNotFound");
  assertEquals(read.error.in, alice);
  assertEquals(read.error.the, "application/json");
  assertEquals(read.error.of, doc);
  assertMatch(
    read.error.message,
    RegExp(`No application/json for ${doc} found in ${alice}`),
  );
});

test(
  "fails to retract if expected version is out of date",
  new URL(`memory:${alice}`),
  async session => {
    const v0 = {
      the: "application/json",
      of: doc,
      is: { v: 0 },
    };

    const v1 = {
      the: "application/json",
      of: doc,
      is: { v: 1 },
      cause: refer(v0),
    };

    const v2 = {
      the: "application/json",
      of: doc,
      is: { v: 2 },
      cause: refer(v1),
    };

    assert(await Repository.assert(session, v0).ok);
    assert(await Repository.assert(session, v1).ok);
    assert(await Repository.assert(session, v2).ok);

    const result = session.transact({
      retract: {
        the: "application/json",
        of: doc,
        is: refer({ v: 1 }),
        cause: refer(v0),
      },
    });

    assert(result.error, "Retract fails if expected version is out of date");
    assert(result.error.name === "ConflictError");
    assertEquals(result.error.expected, refer(v1));
    assertEquals(result.error.actual, v2);
    assertMatch(
      result.error.message,
      RegExp(
        `The application/json of ${doc} in ${alice} was expected to be ${refer(v1)}, but it is ${refer(v2)}`,
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
      the: "application/json",
      of: doc,
      is: { v: 0 },
    });

    assertEquals(
      create,
      {
        ok: {
          in: alice,
          the: "application/json",
          of: doc,
          is: refer({ v: 0 }),
        },
      },
      "created document",
    );

    const select = Repository.query(session, {
      the: "application/json",
      of: doc,
    });

    assertEquals(select.ok, {
      the: "application/json",
      of: doc,
      is: { v: 0 },
    });
  } finally {
    await Deno.remove(url);
  }
});
