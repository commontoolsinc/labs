import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import * as Space from "../space.ts";
import * as Changes from "../changes.ts";
import * as Commit from "../commit.ts";
import * as Transaction from "../transaction.ts";
import * as Fact from "../fact.ts";
import { createTemporaryDirectory, refer } from "../util.ts";

const the = "application/json";
const doc = `of:${refer({ hello: "world" })}` as const;
const space = "did:key:z6MkffDZCkCTWreg8868fG1FGFogcJj5X6PY93pPcWDn9bob";
const alice = "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi";

const test = (
  title: string,
  url: URL,
  run: (replica: Space.View) => Promise<unknown>,
) => {
  const unit = async () => {
    const session = await Space.open({
      url,
    });

    assert(session.ok, "Open create repository if it does not exist");

    try {
      await run(session.ok);
    } finally {
      await Space.close(session.ok);
    }
  };

  if (title.startsWith("only")) {
    Deno.test.only(title, unit);
  } else if (title.startsWith("skip")) {
    Deno.test.ignore(title, unit);
  } else {
    Deno.test(title, unit);
  }
};

test(
  "querying non existing memory returns no facts",
  new URL(`memory:${space}`),
  async (session) => {
    const result = await Space.query(session, {
      cmd: "/memory/query",
      iss: alice,
      sub: space,
      args: {
        select: {
          [doc]: {
            ["application/json"]: {},
          },
        },
      },
    });

    assertEquals(
      result,
      {
        ok: {
          [space]: {
            [doc]: {
              ["application/json"]: {},
            },
          },
        },
      },
      "finds no facts",
    );
  },
);

test("create new memory", new URL(`memory:${space}`), async (session) => {
  const v1 = Fact.assert({
    the: "application/json",
    of: doc,
    is: { v: 1 },
  });

  const tr1 = Transaction.create({
    issuer: alice,
    subject: space,
    changes: Changes.from([v1]),
  });

  const result = await Space.transact(session, tr1);
  const c1 = Commit.create({ space, transaction: tr1 });

  assertEquals(result, {
    ok: Changes.from([c1]),
  });

  const read = Space.query(session, {
    cmd: "/memory/query",
    iss: alice,
    sub: space,
    args: {
      select: {
        [doc]: {
          ["application/json"]: {
            _: {},
          },
        },
      },
    },
  });

  assertEquals(read, {
    ok: {
      [space]: Changes.from([v1]),
    },
  });
});

test("explicit empty creation", new URL(`memory:${space}`), async (session) => {
  assertEquals(
    await Space.query(session, {
      cmd: "/memory/query",
      iss: alice,
      sub: space,
      args: {
        select: {
          [doc]: {
            [the]: {},
          },
        },
      },
    }),
    {
      ok: {
        [space]: {
          [doc]: {
            [the]: {},
          },
        },
      },
    },
  );

  const assertion = Fact.assert({
    the,
    of: doc,
    is: {},
  });

  const transaction = Transaction.create({
    issuer: alice,
    subject: space,
    changes: Changes.from([assertion]),
  });

  assert(await Space.transact(session, transaction).ok);
  assert(await Space.transact(session, transaction).ok);

  assertEquals(
    await Space.query(session, {
      cmd: "/memory/query",
      iss: alice,
      sub: space,
      args: {
        select: {
          [doc]: {
            [the]: {},
          },
        },
      },
    }),
    {
      ok: {
        [space]: Changes.from([assertion]),
      },
    },
  );
});

test("explicit {}", new URL(`memory:${space}`), async (session) => {
  const v1 = Fact.assert({ the, of: doc, is: {} });
  const create = Transaction.create({
    subject: space,
    issuer: alice,
    changes: Changes.from([v1]),
  });

  const init = await Space.transact(session, create);

  assert(init.ok);

  const c1 = Commit.create({ space, transaction: create });

  assertEquals(init, {
    ok: Changes.from([c1]),
  });

  const v2 = Fact.assert({
    the,
    of: doc,
    is: { v: 2 },
    cause: v1,
  });

  const update = Transaction.create({
    issuer: alice,
    subject: space,
    changes: Changes.from([v2]),
  });

  const c2 = Commit.create({ space, transaction: update, cause: c1 });

  assertEquals(await Space.transact(session, update), {
    ok: Changes.from([c2]),
  });
});

test("updates memory", new URL(`memory:${space}`), async (session) => {
  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
  const init = Transaction.create({
    issuer: alice,
    subject: space,
    changes: Changes.from([v1]),
  });

  const create = await Space.transact(session, init);
  const c1 = Commit.create({ space, transaction: init });

  assertEquals(create, {
    ok: Changes.from([c1]),
  });

  const v2 = Fact.assert({
    the,
    of: doc,
    is: { v: 2 },
    cause: v1,
  });

  const change = Transaction.create({
    issuer: alice,
    subject: space,
    changes: Changes.from([v2]),
  });

  const update = await Space.transact(session, change);
  const c2 = Commit.create({ space, transaction: change, cause: c1 });

  assertEquals(
    update,
    {
      ok: Changes.from([c2]),
    },
    "updates document",
  );
});

test(
  "fails updating non-existing memory",
  new URL(`memory:${space}`),
  async (session) => {
    const v1 = Fact.assert({
      the,
      of: doc,
      is: { v: 1 },
    });

    const v2 = Fact.assert({
      the,
      of: doc,
      is: { v: 2 },
      cause: v1,
    });

    const tr = Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([v2]),
    });

    const result = await Space.transact(session, tr);

    assert(result.error, "Update should fail if document does not exists");
    assert(result.error.name === "ConflictError");
    assertEquals(result.error.conflict, {
      space,
      the,
      of: doc,
      expected: refer(v1),
      actual: null,
    });
  },
);

test(
  "create memory fails if already exists",
  new URL(`memory:${space}`),
  async (session) => {
    const base = refer(Fact.unclaimed({ the, of: doc }));
    const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });

    const create = Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([v1]),
    });

    const init = await Space.transact(session, create);

    assert(init.ok, "Document created");

    const r1 = Fact.assert({ the, of: doc, is: { r: 1 } });

    const createRace = Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([r1]),
    });

    const conflict = await Space.transact(session, createRace);

    assert(conflict.error, "Create fail when already exists");
    assert(conflict.error.name === "ConflictError");
    assertEquals(conflict.error.conflict, {
      space,
      the,
      of: doc,
      expected: null,
      actual: v1,
    });
  },
);

test(
  "update does not confuse the/of",
  new URL(`memory:${space}`),
  async (session) => {
    const initial = Fact.assert({ the, of: doc, is: { v: 1 } });

    const initialize = Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([initial]),
    });

    const create = await Space.transact(session, initialize);
    assert(create.ok);

    const malformed = Fact.assert({
      the,
      of: `of:${refer({ doc: 2 })}`,
      is: { a: true },
      cause: refer(initial),
    });

    const change = Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([malformed]),
    });

    const update = await Space.transact(session, change);
    assert(update.error);
    assert(update.error.name === "ConflictError");
    assertEquals(update.error.conflict, {
      space,
      the,
      of: malformed.of,
      expected: refer(initial),
      actual: null,
    });
  },
);

test("concurrent update fails", new URL(`memory:${space}`), async (session) => {
  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
  const t1 = Transaction.create({
    issuer: alice,
    subject: space,
    changes: Changes.from([v1]),
  });

  const r1 = await Space.transact(session, t1);
  assert(r1.ok);
  const c1 = Commit.create({ space, transaction: t1 });
  assertEquals(r1, { ok: Changes.from([c1]) });

  const v2 = Fact.assert({ the, of: doc, is: { v: 2 }, cause: v1 });

  const t2 = Transaction.create({
    issuer: alice,
    subject: space,
    changes: Changes.from([v2]),
  });

  const r2 = await Space.transact(session, t2);
  assert(r2.ok);

  const c2 = Commit.create({ space, transaction: t2, cause: c1 });
  assertEquals(r2, { ok: Changes.from([c2]) });

  const fork = Fact.assert({
    the,
    of: doc,
    is: { fork: true },
    cause: v1,
  });

  const t3 = Transaction.create({
    issuer: alice,
    subject: space,
    changes: Changes.from([fork]),
  });

  const r3 = await Space.transact(session, t3);

  assert(r3.error, "Concurrent update was rejected");
  assert(r3.error.name === "ConflictError");

  assertEquals(r3.error.conflict, {
    space,
    the,
    of: doc,
    expected: refer(v1),
    actual: v2,
  });
});

test(
  "concurrent identical memory creation succeeds",
  new URL(`memory:${space}`),
  async (session) => {
    const v1 = Fact.assert({ the, of: doc, is: { this: doc } });

    const init = Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([v1]),
    });
    const result = await Space.transact(session, init);
    const c1 = Commit.create({ space, transaction: init });

    assertEquals(result, {
      ok: Changes.from([c1]),
    });

    const update = await Space.transact(session, init);
    const c2 = Commit.create({ space, transaction: init, cause: c1 });

    assertEquals(update, {
      ok: Changes.from([c2]),
    });
  },
);

test(
  "concurrent identical memory updates succeed",
  new URL(`memory:${space}`),
  async (session) => {
    const v1 = Fact.assert({
      the,
      of: doc,
      is: { v: 1 },
    });

    const t1 = Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([v1]),
    });
    const r1 = await Space.transact(session, t1);

    assert(r1.ok);

    const c1 = Commit.create({ space, transaction: t1 });
    assertEquals(r1, {
      ok: Changes.from([c1]),
    });

    const v2 = Fact.assert({ the, of: doc, is: { v: 2 }, cause: v1 });

    const t2 = Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([v2]),
    });

    const r2 = await Space.transact(session, t2);
    assert(r2.ok);
    const c2 = Commit.create({ space, transaction: t2, cause: c1 });

    assertEquals(r2, {
      ok: Changes.from([c2]),
    });

    const r3 = await Space.transact(session, t2);
    const c3 = Commit.create({ space, transaction: t2, cause: c2 });

    assertEquals(r3, {
      ok: Changes.from([c3]),
    });
  },
);

test("retract unclaimed", new URL(`memory:${space}`), async (session) => {
  const v0 = Fact.unclaimed({ the, of: doc });
  const retract = Transaction.create({
    issuer: alice,
    subject: space,
    changes: {
      [doc]: {
        [the]: {
          [refer(v0).toString()]: {},
        },
      },
    },
  });

  const retraction = await Space.transact(session, retract);
  const commit = Commit.create({ space, transaction: retract });

  assertEquals(retraction, {
    ok: Changes.from([commit]),
  });

  const includeRetracted = await session.query({
    cmd: "/memory/query",
    iss: alice,
    sub: space,
    args: {
      select: {
        [doc]: {
          [the]: {},
        },
      },
    },
  });

  assertEquals(includeRetracted, {
    ok: {
      [space]: {
        [doc]: {
          [the]: {
            [refer(v0).toString()]: {},
          },
        },
      },
    },
  });

  const withoutRetracted = await session.query({
    cmd: "/memory/query",
    iss: alice,
    sub: space,
    args: {
      select: {
        [doc]: {
          [the]: {
            _: { is: {} },
          },
        },
      },
    },
  });

  assertEquals(withoutRetracted, {
    ok: {
      [space]: {
        [doc]: {
          [the]: {},
        },
      },
    },
  });
});

test("retract document", new URL(`memory:${space}`), async (session) => {
  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
  const t1 = Transaction.create({
    issuer: alice,
    subject: space,
    changes: Changes.from([v1]),
  });
  const create = await Space.transact(session, t1);

  assert(create.ok, "Document created");

  const c1 = Commit.create({ space, transaction: t1 });
  assertEquals(create, { ok: Changes.from([c1]) });

  assertEquals(
    await session.query({
      cmd: "/memory/query",
      iss: alice,
      sub: space,
      args: {
        select: {
          [doc]: {
            [the]: {},
          },
        },
      },
    }),
    {
      ok: {
        [space]: Changes.from([v1]),
      },
    },
  );

  const v2 = Fact.retract(v1);

  const retract = Transaction.create({
    issuer: alice,
    subject: space,
    changes: Changes.from([v2]),
  });

  const drop = session.transact(retract);
  const c2 = Commit.create({ space, transaction: retract, cause: c1 });

  assertEquals(drop, { ok: Changes.from([c2]) });

  assertEquals(
    await session.query({
      cmd: "/memory/query",
      iss: alice,
      sub: space,
      args: {
        select: {
          [doc]: {
            [the]: {},
          },
        },
      },
    }),
    {
      ok: { [space]: Changes.from([v2]) },
    },
    "once retracted `is` no longer included",
  );
});

test(
  "fails to retract if expected version is out of date",
  new URL(`memory:${space}`),
  async (session) => {
    const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
    const v2 = Fact.assert({ the, of: doc, is: { v: 2 }, cause: v1 });
    const v3 = Fact.assert({ the, of: doc, is: { v: 3 }, cause: v2 });

    const t1 = Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([v1]),
    });

    const t2 = Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([v2]),
    });

    const t3 = Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([v3]),
    });

    assert(await session.transact(t1).ok);
    assert(await session.transact(t2).ok);
    assert(await session.transact(t3).ok);

    const r2 = Fact.retract(v2);

    const result = session.transact(
      Transaction.create({
        issuer: alice,
        subject: space,
        changes: Changes.from([r2]),
      }),
    );

    assert(result.error, "Retract fails if expected version is out of date");
    assert(result.error.name === "ConflictError");
    assertEquals(result.error.conflict, {
      space,
      the,
      of: doc,
      expected: refer(v2),
      actual: v3,
    });

    assertMatch(
      result.error.message,
      RegExp(
        `The application/json of ${doc} in ${space} was expected to be ${
          refer(
            v2,
          )
        }, but it is ${refer(v3)}`,
      ),
    );
  },
);

test(
  "new memory creation fails after retraction",
  new URL(`memory:${alice}`),
  async (session) => {
    const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
    const t1 = Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([v1]),
    });

    const create = await Space.transact(session, t1);

    assert(create.ok, "Document created");
    const c1 = Commit.create({ space, transaction: t1 });
    assertEquals(create, { ok: Changes.from([c1]) });

    const v2 = Fact.retract(v1);
    const t2 = Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([v2]),
    });

    const retract = Space.transact(session, t2);
    const c2 = Commit.create({ space, transaction: t2, cause: c1 });

    assertEquals(retract, {
      ok: Changes.from([c2]),
    });

    const v3 = Fact.assert({ the, of: doc, is: { conflict: true } });

    const t3 = Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([v3]),
    });

    const conflict = await Space.transact(session, t3);

    assert(conflict.error, "Create fails if cause not specified");
    assert(conflict.error.name === "ConflictError");
    assertEquals(conflict.error.conflict, {
      space: space,
      the,
      of: doc,
      expected: null,
      actual: v2,
    });
  },
);

test("batch updates", new URL(`memory:${space}`), async (session) => {
  const hi = `of:${refer({ hi: "world" })}` as const;
  const hola = `of:${refer({ hola: "mundo" })}` as const;
  const ciao = `of:${refer({ ciao: "mondo" })}` as const;

  const hi1 = Fact.assert({ the, of: hi, is: { hi: 1 } });
  const hola1 = Fact.assert({ the, of: hola, is: { hola: 1 } });

  const tr1 = Transaction.create({
    issuer: alice,
    subject: space,
    meta: {
      message: "initialize",
    },
    changes: Changes.from([hi1, hola1]),
  });

  const init = await session.transact(tr1);
  assert(init.ok);

  const c1 = Commit.create({ space, transaction: tr1 });

  assertEquals(init, {
    ok: Changes.from([c1]),
  });

  assertEquals(
    await session.query({
      cmd: "/memory/query",
      iss: alice,
      sub: space,
      args: {
        select: {
          [hi]: {
            [the]: {},
          },
        },
      },
    }),
    {
      ok: {
        [space]: Changes.from([hi1]),
      },
    },
  );

  assertEquals(
    await session.query({
      cmd: "/memory/query",
      iss: alice,
      sub: space,
      args: {
        select: {
          [hola]: {
            [the]: {},
          },
        },
      },
    }),
    {
      ok: {
        [space]: Changes.from([hola1]),
      },
    },
  );

  const hi2 = Fact.assert({ the, of: hi, is: { hi: 2 }, cause: hi1 });
  const hola2 = Fact.assert({ the, of: hola, is: { hola: 2 }, cause: hola1 });
  const ciao1 = Fact.assert({ the, of: ciao, is: { ciao: 1 } });

  const tr2 = Transaction.create({
    issuer: alice,
    subject: space,
    meta: {
      message: "update",
    },
    changes: Changes.from([
      hi2, // update
      ciao1, // create
      Fact.claim(hola1), // claim
    ]),
  });

  const update = await session.transact(tr2);
  assert(update.ok);

  const c2 = Commit.create({ space, transaction: tr2, cause: c1 });
  assertEquals(update, { ok: Changes.from([c2]) });

  assertEquals(
    await session.query({
      cmd: "/memory/query",
      iss: alice,
      sub: space,
      args: {
        select: {
          [hi]: {
            [the]: {},
          },
        },
      },
    }),
    {
      ok: { [space]: Changes.from([hi2]) },
    },
  );

  assertEquals(
    await session.query({
      cmd: "/memory/query",
      iss: alice,
      sub: space,
      args: {
        select: {
          [hola]: {},
        },
      },
    }),
    {
      ok: { [space]: Changes.from([hola1]) },
    },
  );

  assertEquals(
    await session.query({
      cmd: "/memory/query",
      iss: alice,
      sub: space,
      args: {
        select: {
          [ciao]: {},
        },
      },
    }),
    {
      ok: { [space]: Changes.from([ciao1]) },
    },
  );

  // Fails on mismatched invariant

  const tr3 = Transaction.create({
    issuer: alice,
    subject: space,
    meta: {
      message: "bad invariant",
    },
    changes: Changes.from([
      Fact.claim(hi1), // Out of date invariant
      hola2,
    ]),
  });

  const badInvariant = session.transact(tr3);
  assert(badInvariant.error);
  assert(badInvariant.error.name == "ConflictError");
  assertEquals(badInvariant.error.conflict, {
    space,
    the,
    of: hi,
    expected: refer(hi1),
    actual: hi2,
  });

  assertEquals(
    await session.query({
      cmd: "/memory/query",
      iss: alice,
      sub: space,
      args: {
        select: {
          [ciao]: {},
        },
      },
    }),
    {
      ok: { [space]: Changes.from([ciao1]) },
    },
    "doc3 was not updated",
  );
});

Deno.test("fail to connect to non-existing replica", async () => {
  const url = new URL(`./${alice}.sqlite`, await createTemporaryDirectory());
  const session = await Space.connect({ url });

  await assert(session.error, "Replica does not exist");

  if (session.error) {
    assertEquals(session.error.name, "ConnectionError");
    assertEquals(session.error.address, url.href);
  }
});

Deno.test("open creates replica if does not exists", async () => {
  const url = new URL(`./${alice}.sqlite`, await createTemporaryDirectory());

  try {
    const open = await Space.open({
      url,
    });

    await assert(open.ok, "Opened a repository");

    const session = open.ok as Space.View;
    const v1 = Fact.assert({
      the,
      of: doc,
      is: { v: 1 },
    });

    const t1 = Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([v1]),
    });
    const create = await Space.transact(session, t1);
    const c1 = Commit.create({
      space,
      transaction: t1,
    });

    assertEquals(
      create,
      {
        ok: Changes.from([c1]),
      },
      "created document",
    );

    const select = session.query({
      cmd: "/memory/query",
      iss: alice,
      sub: space,
      args: {
        select: {
          [doc]: {},
        },
      },
    });

    assertEquals(select, {
      ok: { [space]: Changes.from([v1]) },
    });
  } finally {
    await Deno.remove(url);
  }
});

test("list empty store", new URL(`memory:${space}`), async (session) => {
  const result = session.query({
    cmd: "/memory/query",
    iss: alice,
    sub: space,
    args: {
      select: {
        [doc]: {},
      },
    },
  });
  assertEquals(result, { ok: { [space]: { [doc]: {} } } }, "no facts exist");
});

test("list single fact", new URL(`memory:${space}`), async (session) => {
  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
  const tr = Transaction.create({
    issuer: alice,
    subject: space,
    changes: Changes.from([v1]),
  });
  const write = await session.transact(tr);
  assert(write.ok);

  const result = session.query({
    cmd: "/memory/query",
    iss: alice,
    sub: space,
    args: {
      select: {
        [doc]: {},
      },
    },
  });

  assertEquals(result, {
    ok: { [space]: Changes.from([v1]) },
  });
});

test(
  "ony list excludes retracted facts",
  new URL(`memory:${space}`),
  async (session) => {
    const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
    // Create and then retract a fact
    const tr = Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([v1]),
    });
    const fact = await session.transact(tr);

    assert(fact.ok);
    const v2 = Fact.retract(v1);
    const tr2 = Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([v2]),
    });
    const retract = session.transact(tr2);
    assert(retract.ok);

    const result = session.query({
      cmd: "/memory/query",
      iss: alice,
      sub: space,
      args: {
        select: {
          _: {
            ["application/json"]: {
              _: {
                is: {},
              },
            },
          },
        },
      },
    });

    assertEquals(
      result,
      {
        ok: { [space]: {} },
      },
      "does not list retracted",
    );

    const withRetractions = session.query({
      cmd: "/memory/query",
      iss: alice,
      sub: space,
      args: {
        select: {
          _: {
            ["application/json"]: {
              _: {},
            },
          },
        },
      },
    });

    assertEquals(
      withRetractions,
      {
        ok: { [space]: Changes.from([v2]) },
      },
      "selects retracted facts",
    );
  },
);
