import { assert, assertEquals, assertExists, assertMatch } from "@std/assert";
import * as Space from "../space.ts";
import * as Changes from "../changes.ts";
import * as Commit from "../commit.ts";
import * as Transaction from "../transaction.ts";
import * as Fact from "../fact.ts";
import { createTemporaryDirectory } from "../util.ts";
import { refer } from "merkle-reference";

import { alice, space } from "./principal.ts";
import { SchemaSelector } from "../space.ts";
import { AssertFact, SchemaContext } from "../interface.ts";
const the = "application/json";
const doc = `of:${refer({ hello: "world" })}` as const;
const doc2 = `of:${refer({ goodbye: "world" })}` as const;
const doc3 = `of:${refer({ goodbye: "cruel world" })}` as const;

// Helper function to make query comparisons easier
// Since our result is returned with a match for each selector schema,
// it comes back wrapped in another array, we'll compare it to a fact
// assert of an array version.
function getResultAtPath(
  obj: Record<string, AssertFact<any>>,
  path: string[],
): any {
  const entries = Object.entries(obj);
  assertEquals(entries.length, 1);
  for (const [cause, val] of entries) {
    // Our isResults will contain an entry for each selector, so it will
    // always have an array as its value type.
    let current = val.is;
    for (const key of path) {
      if (current === undefined || current === null) return undefined;
      current = current[key];
    }
    assertEquals(current.length, 1);
    return current[0];
  }
}

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

const DB = new URL(`memory:${space.did()}`);

test(
  "querying non existing memory returns no facts",
  new URL(`memory:${space.did()}`),
  async (session) => {
    const result = await Space.query(session, {
      cmd: "/memory/query",
      iss: alice.did(),
      sub: space.did(),
      args: {
        select: {
          [doc]: {
            ["application/json"]: {},
          },
        },
      },
      prf: [],
    });

    assertEquals(
      result,
      {
        ok: {
          [space.did()]: {
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

test("create new memory", DB, async (session) => {
  const v1 = Fact.assert({
    the: "application/json",
    of: doc,
    is: { v: 1 },
  });

  const tr1 = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v1]),
  });

  const result = await Space.transact(session, tr1);
  const c1 = Commit.create({ space: space.did(), transaction: tr1 });

  assertEquals(result, {
    ok: Changes.from([c1]),
  });

  const read = Space.query(session, {
    cmd: "/memory/query",
    iss: alice.did(),
    sub: space.did(),
    args: {
      select: {
        [doc]: {
          ["application/json"]: {
            _: {},
          },
        },
      },
    },
    prf: [],
  });

  assertEquals(read, {
    ok: {
      [space.did()]: Changes.from([v1]),
    },
  });
});

test("explicit empty creation", DB, async (session) => {
  assertEquals(
    await Space.query(session, {
      cmd: "/memory/query",
      iss: alice.did(),
      sub: space.did(),
      args: {
        select: {
          [doc]: {
            [the]: {},
          },
        },
      },
      prf: [],
    }),
    {
      ok: {
        [space.did()]: {
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
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([assertion]),
  });

  assert(await Space.transact(session, transaction).ok);
  assert(await Space.transact(session, transaction).ok);

  assertEquals(
    await Space.query(session, {
      cmd: "/memory/query",
      iss: alice.did(),
      sub: space.did(),
      args: {
        select: {
          [doc]: {
            [the]: {},
          },
        },
      },
      prf: [],
    }),
    {
      ok: {
        [space.did()]: Changes.from([assertion]),
      },
    },
  );
});

test("explicit {}", DB, async (session) => {
  const v1 = Fact.assert({ the, of: doc, is: {} });
  const create = Transaction.create({
    subject: space.did(),
    issuer: alice.did(),
    changes: Changes.from([v1]),
  });

  const init = await Space.transact(session, create);

  assert(init.ok);

  const c1 = Commit.create({ space: space.did(), transaction: create });

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
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v2]),
  });

  const c2 = Commit.create({
    space: space.did(),
    transaction: update,
    cause: c1,
  });

  assertEquals(await Space.transact(session, update), {
    ok: Changes.from([c2]),
  });
});

test("updates memory", DB, async (session) => {
  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
  const init = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v1]),
  });

  const create = await Space.transact(session, init);
  const c1 = Commit.create({ space: space.did(), transaction: init });

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
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v2]),
  });

  const update = await Space.transact(session, change);
  const c2 = Commit.create({
    space: space.did(),
    transaction: change,
    cause: c1,
  });

  assertEquals(
    update,
    {
      ok: Changes.from([c2]),
    },
    "updates document",
  );
});

test("fails updating non-existing memory", DB, async (session) => {
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
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v2]),
  });

  const result = await Space.transact(session, tr);

  assert(result.error, "Update should fail if document does not exists");
  assert(result.error.name === "ConflictError");
  assertEquals(result.error.conflict, {
    space: space.did(),
    the,
    of: doc,
    expected: refer(v1),
    actual: null,
  });
});

test("create memory fails if already exists", DB, async (session) => {
  const base = refer(Fact.unclaimed({ the, of: doc }));
  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });

  const create = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v1]),
  });

  const init = await Space.transact(session, create);

  assert(init.ok, "Document created");

  const r1 = Fact.assert({ the, of: doc, is: { r: 1 } });

  const createRace = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([r1]),
  });

  const conflict = await Space.transact(session, createRace);

  assert(conflict.error, "Create fail when already exists");
  assert(conflict.error.name === "ConflictError");
  assertEquals(conflict.error.conflict, {
    space: space.did(),
    the,
    of: doc,
    expected: null,
    actual: v1,
  });
});

test("update does not confuse the/of", DB, async (session) => {
  const initial = Fact.assert({ the, of: doc, is: { v: 1 } });

  const initialize = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
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
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([malformed]),
  });

  const update = await Space.transact(session, change);
  assert(update.error);
  assert(update.error.name === "ConflictError");
  assertEquals(update.error.conflict, {
    space: space.did(),
    the,
    of: malformed.of,
    expected: refer(initial),
    actual: null,
  });
});

test("concurrent update fails", DB, async (session) => {
  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
  const t1 = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v1]),
  });

  const r1 = await Space.transact(session, t1);
  assert(r1.ok);
  const c1 = Commit.create({ space: space.did(), transaction: t1 });
  assertEquals(r1, { ok: Changes.from([c1]) });

  const v2 = Fact.assert({ the, of: doc, is: { v: 2 }, cause: v1 });

  const t2 = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v2]),
  });

  const r2 = await Space.transact(session, t2);
  assert(r2.ok);

  const c2 = Commit.create({ space: space.did(), transaction: t2, cause: c1 });
  assertEquals(r2, { ok: Changes.from([c2]) });

  const fork = Fact.assert({
    the,
    of: doc,
    is: { fork: true },
    cause: v1,
  });

  const t3 = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([fork]),
  });

  const r3 = await Space.transact(session, t3);

  assert(r3.error, "Concurrent update was rejected");
  assert(r3.error.name === "ConflictError");

  assertEquals(r3.error.conflict, {
    space: space.did(),
    the,
    of: doc,
    expected: refer(v1),
    actual: v2,
  });
});

test("concurrent identical memory creation succeeds", DB, async (session) => {
  const v1 = Fact.assert({ the, of: doc, is: { this: doc } });

  const init = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v1]),
  });
  const result = await Space.transact(session, init);
  const c1 = Commit.create({ space: space.did(), transaction: init });

  assertEquals(result, {
    ok: Changes.from([c1]),
  });

  const update = await Space.transact(session, init);
  const c2 = Commit.create({
    space: space.did(),
    transaction: init,
    cause: c1,
  });

  assertEquals(update, {
    ok: Changes.from([c2]),
  });
});

test("concurrent identical memory updates succeed", DB, async (session) => {
  const v1 = Fact.assert({
    the,
    of: doc,
    is: { v: 1 },
  });

  const t1 = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v1]),
  });
  const r1 = await Space.transact(session, t1);

  assert(r1.ok);

  const c1 = Commit.create({ space: space.did(), transaction: t1 });
  assertEquals(r1, {
    ok: Changes.from([c1]),
  });

  const v2 = Fact.assert({ the, of: doc, is: { v: 2 }, cause: v1 });

  const t2 = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v2]),
  });

  const r2 = await Space.transact(session, t2);
  assert(r2.ok);
  const c2 = Commit.create({ space: space.did(), transaction: t2, cause: c1 });

  assertEquals(r2, {
    ok: Changes.from([c2]),
  });

  const r3 = await Space.transact(session, t2);
  const c3 = Commit.create({ space: space.did(), transaction: t2, cause: c2 });

  assertEquals(r3, {
    ok: Changes.from([c3]),
  });
});

test("retract unclaimed", DB, async (session) => {
  const v0 = Fact.unclaimed({ the, of: doc });
  const retract = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: {
      [doc]: {
        [the]: {
          [refer(v0).toString()]: {},
        },
      },
    },
  });

  const retraction = await Space.transact(session, retract);
  const commit = Commit.create({ space: space.did(), transaction: retract });

  assertEquals(retraction, {
    ok: Changes.from([commit]),
  });

  const includeRetracted = await session.query({
    cmd: "/memory/query",
    iss: alice.did(),
    sub: space.did(),
    args: {
      select: {
        [doc]: {
          [the]: {},
        },
      },
    },
    prf: [],
  });

  assertEquals(includeRetracted, {
    ok: {
      [space.did()]: {
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
    iss: alice.did(),
    sub: space.did(),
    args: {
      select: {
        [doc]: {
          [the]: {
            _: { is: {} },
          },
        },
      },
    },
    prf: [],
  });

  assertEquals(withoutRetracted, {
    ok: {
      [space.did()]: {
        [doc]: {
          [the]: {},
        },
      },
    },
  });
});

test("retract document", DB, async (session) => {
  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
  const t1 = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v1]),
  });
  const create = await Space.transact(session, t1);

  assert(create.ok, "Document created");

  const c1 = Commit.create({ space: space.did(), transaction: t1 });
  assertEquals(create, { ok: Changes.from([c1]) });

  assertEquals(
    await session.query({
      cmd: "/memory/query",
      iss: alice.did(),
      sub: space.did(),
      args: {
        select: {
          [doc]: {
            [the]: {},
          },
        },
      },
      prf: [],
    }),
    {
      ok: {
        [space.did()]: Changes.from([v1]),
      },
    },
  );

  const v2 = Fact.retract(v1);

  const retract = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v2]),
  });

  const drop = session.transact(retract);
  const c2 = Commit.create({
    space: space.did(),
    transaction: retract,
    cause: c1,
  });

  assertEquals(drop, { ok: Changes.from([c2]) });

  assertEquals(
    await session.query({
      cmd: "/memory/query",
      iss: alice.did(),
      sub: space.did(),
      args: {
        select: {
          [doc]: {
            [the]: {},
          },
        },
      },
      prf: [],
    }),
    {
      ok: { [space.did()]: Changes.from([v2]) },
    },
    "once retracted `is` no longer included",
  );
});

test(
  "fails to retract if expected version is out of date",
  DB,
  async (session) => {
    const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
    const v2 = Fact.assert({ the, of: doc, is: { v: 2 }, cause: v1 });
    const v3 = Fact.assert({ the, of: doc, is: { v: 3 }, cause: v2 });

    const t1 = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([v1]),
    });

    const t2 = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([v2]),
    });

    const t3 = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([v3]),
    });

    assert(await session.transact(t1).ok);
    assert(await session.transact(t2).ok);
    assert(await session.transact(t3).ok);

    const r2 = Fact.retract(v2);

    const result = session.transact(
      Transaction.create({
        issuer: alice.did(),
        subject: space.did(),
        changes: Changes.from([r2]),
      }),
    );

    assert(result.error, "Retract fails if expected version is out of date");
    assert(result.error.name === "ConflictError");
    assertEquals(result.error.conflict, {
      space: space.did(),
      the,
      of: doc,
      expected: refer(v2),
      actual: v3,
    });

    assertMatch(
      result.error.message,
      RegExp(
        `The application/json of ${doc} in ${space.did()} was expected to be ${
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
  new URL(`memory:${alice.did()}`),
  async (session) => {
    const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
    const t1 = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([v1]),
    });

    const create = await Space.transact(session, t1);

    assert(create.ok, "Document created");
    const c1 = Commit.create({ space: space.did(), transaction: t1 });
    assertEquals(create, { ok: Changes.from([c1]) });

    const v2 = Fact.retract(v1);
    const t2 = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([v2]),
    });

    const retract = Space.transact(session, t2);
    const c2 = Commit.create({
      space: space.did(),
      transaction: t2,
      cause: c1,
    });

    assertEquals(retract, {
      ok: Changes.from([c2]),
    });
    assertEquals(retract, {
      ok: Changes.from([c2]),
    });

    const v3 = Fact.assert({ the, of: doc, is: { conflict: true } });

    const t3 = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([v3]),
    });

    const conflict = await Space.transact(session, t3);

    assert(conflict.error, "Create fails if cause not specified");
    assert(conflict.error.name === "ConflictError");
    assertEquals(conflict.error.conflict, {
      space: space.did(),
      the,
      of: doc,
      expected: null,
      actual: v2,
    });
  },
);

test("batch updates", DB, async (session) => {
  const hi = `of:${refer({ hi: "world" })}` as const;
  const hola = `of:${refer({ hola: "mundo" })}` as const;
  const ciao = `of:${refer({ ciao: "mondo" })}` as const;

  const hi1 = Fact.assert({ the, of: hi, is: { hi: 1 } });
  const hola1 = Fact.assert({ the, of: hola, is: { hola: 1 } });

  const tr1 = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    meta: {
      message: "initialize",
    },
    changes: Changes.from([hi1, hola1]),
  });

  const init = await session.transact(tr1);
  assert(init.ok);

  const c1 = Commit.create({ space: space.did(), transaction: tr1 });

  assertEquals(init, {
    ok: Changes.from([c1]),
  });

  assertEquals(
    await session.query({
      cmd: "/memory/query",
      iss: alice.did(),
      sub: space.did(),
      args: {
        select: {
          [hi]: {
            [the]: {},
          },
        },
      },
      prf: [],
    }),
    {
      ok: {
        [space.did()]: Changes.from([hi1]),
      },
    },
  );

  assertEquals(
    await session.query({
      cmd: "/memory/query",
      iss: alice.did(),
      sub: space.did(),
      args: {
        select: {
          [hola]: {
            [the]: {},
          },
        },
      },
      prf: [],
    }),
    {
      ok: {
        [space.did()]: Changes.from([hola1]),
      },
    },
  );

  const hi2 = Fact.assert({ the, of: hi, is: { hi: 2 }, cause: hi1 });
  const hola2 = Fact.assert({ the, of: hola, is: { hola: 2 }, cause: hola1 });
  const ciao1 = Fact.assert({ the, of: ciao, is: { ciao: 1 } });

  const tr2 = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
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

  const c2 = Commit.create({ space: space.did(), transaction: tr2, cause: c1 });
  assertEquals(update, { ok: Changes.from([c2]) });

  assertEquals(
    await session.query({
      cmd: "/memory/query",
      iss: alice.did(),
      sub: space.did(),
      args: {
        select: {
          [hi]: {
            [the]: {},
          },
        },
      },
      prf: [],
    }),
    {
      ok: { [space.did()]: Changes.from([hi2]) },
    },
  );

  assertEquals(
    await session.query({
      cmd: "/memory/query",
      iss: alice.did(),
      sub: space.did(),
      args: {
        select: {
          [hola]: {},
        },
      },
      prf: [],
    }),
    {
      ok: { [space.did()]: Changes.from([hola1]) },
    },
  );

  assertEquals(
    await session.query({
      cmd: "/memory/query",
      iss: alice.did(),
      sub: space.did(),
      args: {
        select: {
          [ciao]: {},
        },
      },
      prf: [],
    }),
    {
      ok: { [space.did()]: Changes.from([ciao1]) },
    },
  );

  // Fails on mismatched invariant

  const tr3 = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
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
    space: space.did(),
    the,
    of: hi,
    expected: refer(hi1),
    actual: hi2,
  });

  assertEquals(
    await session.query({
      cmd: "/memory/query",
      iss: alice.did(),
      sub: space.did(),
      args: {
        select: {
          [ciao]: {},
        },
      },
      prf: [],
    }),
    {
      ok: { [space.did()]: Changes.from([ciao1]) },
    },
    "doc3 was not updated",
  );
});

Deno.test("fail to connect to non-existing replica", async () => {
  const url = new URL(
    `./${space.did()}.sqlite`,
    await createTemporaryDirectory(),
  );
  const session = await Space.connect({ url });

  await assert(session.error, "Replica does not exist");

  if (session.error) {
    assertEquals(session.error.name, "ConnectionError");
    assertEquals(session.error.address, url.href);
  }
});

test(
  "open creates replica if does not exists",
  new URL(`./${space.did()}.sqlite`, await createTemporaryDirectory()),
  async (session) => {
    const v1 = Fact.assert({
      the,
      of: doc,
      is: { v: 1 },
    });

    const t1 = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([v1]),
    });
    const create = await Space.transact(session, t1);
    const c1 = Commit.create({
      space: space.did(),
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
      iss: alice.did(),
      sub: space.did(),
      args: {
        select: {
          [doc]: {},
        },
      },
      prf: [],
    });

    assertEquals(select, {
      ok: { [space.did()]: Changes.from([v1]) },
    });
  },
);

test("list empty store", DB, async (session) => {
  const result = await session.query({
    cmd: "/memory/query",
    iss: alice.did(),
    sub: space.did(),
    args: {
      select: {
        [doc]: {},
      },
    },
    prf: [],
  });
  assertEquals(
    result,
    { ok: { [space.did()]: { [doc]: {} } } },
    "no facts exist",
  );
});

test("list single fact", DB, async (session) => {
  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
  const tr = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v1]),
  });
  const write = await session.transact(tr);
  assert(write.ok);

  const result = session.query({
    cmd: "/memory/query",
    iss: alice.did(),
    sub: space.did(),
    args: {
      select: {
        [doc]: {},
      },
    },
    prf: [],
  });

  assertEquals(result, {
    ok: { [space.did()]: Changes.from([v1]) },
  });
});

test("list excludes retracted facts", DB, async (session) => {
  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
  // Create and then retract a fact
  const tr = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v1]),
  });
  const fact = await session.transact(tr);

  assert(fact.ok);
  const v2 = Fact.retract(v1);
  const tr2 = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v2]),
  });
  const retract = session.transact(tr2);
  assert(retract.ok);

  const result = session.query({
    cmd: "/memory/query",
    iss: alice.did(),
    sub: space.did(),
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
    prf: [],
  });

  assertEquals(
    result,
    {
      ok: { [space.did()]: {} },
    },
    "does not list retracted",
  );

  const withRetractions = session.query({
    cmd: "/memory/query",
    iss: alice.did(),
    sub: space.did(),
    args: {
      select: {
        _: {
          ["application/json"]: {
            _: {},
          },
        },
      },
    },
    prf: [],
  });

  assertEquals(
    withRetractions,
    {
      ok: { [space.did()]: Changes.from([v2]) },
    },
    "selects retracted facts",
  );
});

test("list single fact with schema query", DB, async (session) => {
  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
  const tr = Transaction.create({
    issuer: alice.did(),
    subject: space.did(),
    changes: Changes.from([v1]),
  });
  const write = await session.transact(tr);
  assert(write.ok);

  const subscriptions: SchemaContext = {
    schema: { "type": "number" },
    rootSchema: {
      "type": "object",
      "properties": { "v": { "type": "number" } },
    },
  };

  const sampleSchemaSelector: SchemaSelector = {
    [doc]: {
      [the]: {
        _: {
          path: ["v"],
          schemaContext: subscriptions,
        },
      },
    },
  };

  const result = session.querySchema({
    cmd: "/memory/graph/query",
    iss: alice.did(),
    sub: space.did(),
    args: {
      selectSchema: sampleSchemaSelector,
    },
    prf: [],
  });

  assertEquals(result, {
    ok: { [space.did()]: Changes.from([v1]) },
  });
});

test(
  "list fact through alias with schema query and schema filter",
  DB,
  async (session) => {
    const v1 = Fact.assert({
      the,
      of: doc2,
      is: {
        "home": {
          "name": "Mr. Bob Hope",
          "street": "2466 Southridge Drive",
          "city": "Palm Springs",
        },
        "work": {
          "name": "Mr. Bob Hope",
          "street": "2627 N Hollywood Way",
          "city": "Burbank",
        },
      },
    });

    const v2 = Fact.assert({
      the,
      of: doc,
      is: {
        "address": {
          "$alias": {
            "cell": {
              "/": doc2.slice(3), // strip off 'of:'
            },
            "path": ["home"],
          },
        },
        "name": "Bob",
      },
    });

    const tr1 = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([v1]),
    });
    const write1 = await session.transact(tr1);
    assert(write1.ok);
    const tr2 = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([v2]),
    });
    const write2 = await session.transact(tr2);
    assert(write2.ok);

    // We'll use a schema selector to exclude the name from the address, since we already have that
    const schemaSelector: SchemaSelector = {
      [doc]: {
        [the]: {
          _: {
            path: ["address"],
            schemaContext: {
              schema: {
                "type": "object",
                "properties": {
                  "street": { "type": "string" },
                  "city": { "type": "string" },
                },
              },
              rootSchema: {
                "type": "object",
                "properties": {
                  "street": { "type": "string" },
                  "city": { "type": "string" },
                },
              },
            },
          },
        },
      },
    };

    const result = session.querySchema({
      cmd: "/memory/graph/query",
      iss: alice.did(),
      sub: space.did(),
      args: {
        selectSchema: schemaSelector,
      },
      prf: [],
    });

    const cause = refer(Fact.unclaimed({ the, of: doc }));
    // We should not have the name in the returned value, since our schema excludes it
    const addressFact = {
      [doc]: {
        [the]: {
          [cause.toString()]: {
            is: {
              "address": {
                "street": "2466 Southridge Drive",
                "city": "Palm Springs",
              },
            },
          },
        },
      },
    };

    assertEquals(result, {
      ok: { [space.did()]: addressFact },
    });
  },
);

test(
  "list fact through multiple aliases",
  DB,
  async (session) => {
    const v1 = Fact.assert({
      the,
      of: doc,
      is: {
        "home": {
          "name": {
            "title": "Mr.",
            "first": "Bob",
            "last": "Hope",
          },
          "street": "2466 Southridge Drive",
          "city": "Palm Springs",
        },
        "work": {
          "name": {
            "title": "Mr.",
            "first": "Bob",
            "last": "Hope",
          },
          "street": "2627 N Hollywood Way",
          "city": "Burbank",
        },
      },
    });

    const v2 = Fact.assert({
      the,
      of: doc2,
      is: {
        "address": {
          "$alias": {
            "cell": {
              "/": doc.slice(3), // strip off 'of:'
            },
            "path": ["home"],
          },
        },
      },
    });

    const v3 = Fact.assert({
      the,
      of: doc3,
      is: {
        "emergency_contacts": [
          {
            "$alias": {
              "cell": {
                "/": doc2.slice(3), // strip off 'of:'
              },
              "path": ["address", "name"],
            },
          },
        ],
      },
    });

    for (const fact of [v1, v2, v3]) {
      const tr = Transaction.create({
        issuer: alice.did(),
        subject: space.did(),
        changes: Changes.from([fact]),
      });
      const write = await session.transact(tr);
      assert(write.ok);
    }

    // We'll use a schema selector to exclude the name from the address, since we already have that
    const schemaSelector: SchemaSelector = {
      [doc3]: {
        [the]: {
          _: {
            path: ["emergency_contacts", "0", "first"],
            schemaContext: {
              schema: { "type": "string" },
              rootSchema: {
                "type": "object",
                "properties": {
                  "emergency-contacts": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "title": { "type": "string" },
                        "first": { "type": "string" },
                        "last": { "type": "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const result = session.querySchema({
      cmd: "/memory/graph/query",
      iss: alice.did(),
      sub: space.did(),
      args: {
        selectSchema: schemaSelector,
      },
      prf: [],
    });

    const cause = refer(Fact.unclaimed({ the, of: doc3 }));
    // Our aliases and schema query path mean that we just get the first name
    const addressFact = {
      [doc3]: {
        [the]: {
          [cause.toString()]: {
            is: {
              "emergency_contacts": [{
                "first": "Bob",
              }],
            },
          },
        },
      },
    };

    assertEquals(result, {
      ok: { [space.did()]: addressFact },
    });
  },
);

test(
  "list single fact with schema query and schema filter using $ref",
  DB,
  async (session) => {
    const v1 = Fact.assert({
      the,
      of: doc,
      is: {
        "name": "Bob",
        "left": { "name": "Alice" },
        "right": { "name": "Charlie " },
      },
    });
    const tr = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([v1]),
    });
    const write = await session.transact(tr);
    assert(write.ok);

    const schemaSelector: SchemaSelector = {
      [doc]: {
        [the]: {
          _: {
            path: ["left"],
            schemaContext: {
              schema: {
                "type": "object",
                "properties": {
                  "name": { "type": "string" },
                  "left": { "$ref": "#" },
                  "right": { "$ref": "#" },
                },
                "required": ["name"],
              },
              rootSchema: {
                "type": "object",
                "properties": {
                  "name": { "type": "string" },
                  "left": { "$ref": "#" },
                  "right": { "$ref": "#" },
                },
                "required": ["name"],
              },
            },
          },
        },
      },
    };

    const result = session.querySchema({
      cmd: "/memory/graph/query",
      iss: alice.did(),
      sub: space.did(),
      args: {
        selectSchema: schemaSelector,
      },
      prf: [],
    });

    const filteredFact = Fact.assert({
      the,
      of: doc,
      is: { "left": { "name": "Alice" } },
    });
    assertEquals(result, {
      ok: { [space.did()]: Changes.from([filteredFact]) },
    });
  },
);

// This test may be too similer to the previous one
test(
  "list single fact with schema query and schema filter using $ref",
  DB,
  async (session) => {
    const v1 = Fact.assert({
      the,
      of: doc,
      is: {
        "emails": [
          {
            "sender": "spamsender@sweepstakes.com",
            "subject": "You may have won the sweepstakes",
            "body": "This is your chance to claim your winnings",
          },
          {
            "sender": "boss@job.com",
            "subject": "You're fired!",
            "body": "You've crashed the last delivery truck. Pack your bags!",
          },
        ],
      },
    });
    const tr = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([v1]),
    });
    const write = await session.transact(tr);
    assert(write.ok);

    const schemaSelector: SchemaSelector = {
      [doc]: {
        [the]: {
          _: {
            path: ["emails"],
            schemaContext: {
              schema: {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "sender": { "type": "string" },
                    "subject": { "type": "string" },
                  },
                  "required": ["sender"],
                },
              },
              rootSchema: {
                "type": "object",
                "properties": {
                  "emails": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "sender": { "type": "string" },
                        "subject": { "type": "string" },
                      },
                      "required": ["sender"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const result = session.querySchema({
      cmd: "/memory/graph/query",
      iss: alice.did(),
      sub: space.did(),
      args: {
        selectSchema: schemaSelector,
      },
      prf: [],
    });

    // We should be getting back the fact without the body
    const filteredFact = Fact.assert({
      the,
      of: doc,
      is: {
        "emails": [
          {
            "sender": "spamsender@sweepstakes.com",
            "subject": "You may have won the sweepstakes",
          },
          {
            "sender": "boss@job.com",
            "subject": "You're fired!",
          },
        ],
      },
    });
    assertEquals(result, {
      ok: { [space.did()]: Changes.from([filteredFact]) },
    });
  },
);
