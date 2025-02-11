import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import * as Space from "../space.ts";
import { refer, createTemporaryDirectory } from "../util.ts";

const the = "application/json";
const doc = refer({ hello: "world" }).toString();
const space = "did:key:z6MkffDZCkCTWreg8868fG1FGFogcJj5X6PY93pPcWDn9bob";
const alice = "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi";

const test = (title: string, url: URL, run: (replica: Space.Store) => Promise<unknown>) => {
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
      cmd: "/space/query",
      iss: alice,
      sub: space,
      args: {
        selector: {
          the: "application/json",
          of: doc,
        },
      },
    });

    assertEquals(
      result,
      {
        ok: [],
      },
      "finds no facts",
    );
  },
);

test("create new memory", new URL(`memory:${space}`), async (session) => {
  const v1 = {
    the: "application/json",
    of: doc,
    is: { v: 1 },
  };
  const result = await Space.transact(
    session,
    Space.transaction({
      issuer: alice,
      subject: space,
      changes: {
        [the]: {
          [doc]: {
            [refer({ the, of: doc }).toString()]: {
              is: { v: 1 },
            },
          },
        },
      },
    }),
  );

  assertEquals(result, {
    ok: Space.toCommit({
      subject: space,
      is: {
        since: 0,
        transaction: Space.transaction({
          issuer: alice,
          subject: space,
          changes: {
            [the]: {
              [doc]: {
                [refer({ the, of: doc }).toString()]: {
                  is: { v: 1 },
                },
              },
            },
          },
        }),
      },
    }),
  });

  const read = Space.query(session, {
    cmd: "/space/query",
    iss: alice,
    sub: space,
    args: {
      selector: {
        the: "application/json",
        of: doc,
      },
    },
  });

  assertEquals(read, {
    ok: [
      {
        the: "application/json",
        of: doc,
        is: { v: 1 },
        cause: refer({
          the: "application/json",
          of: doc,
        }),
      },
    ],
  });
});

test("explicit empty creation", new URL(`memory:${space}`), async (session) => {
  assertEquals(
    await Space.query(session, {
      cmd: "/space/query",
      iss: alice,
      sub: space,
      args: {
        selector: {
          the: "application/json",
          of: doc,
        },
      },
    }),
    {
      ok: [],
    },
  );

  const transaction = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: { [doc]: { [refer({ the, of: doc }).toString()]: { is: {} } } },
    },
  });

  assertEquals(await Space.transact(session, transaction).ok?.is.since, 0);
  assertEquals(await Space.transact(session, transaction).ok?.is.since, 1);

  assertEquals(
    await Space.query(session, {
      cmd: "/space/query",
      iss: alice,
      sub: space,
      args: {
        selector: {
          the: "application/json",
          of: doc,
        },
      },
    }),
    {
      ok: [
        {
          the: "application/json",
          of: doc,
          is: {},
          cause: refer({
            the: "application/json",
            of: doc,
          }),
        },
      ],
    },
  );
});

test("explicit {}", new URL(`memory:${space}`), async (session) => {
  const create = Space.transaction({
    subject: space,
    issuer: alice,
    changes: {
      [the]: {
        [doc]: {
          [refer({ the, of: doc }).toString()]: {
            is: {},
          },
        },
      },
    },
  });

  const init = await Space.transact(session, create);

  assertEquals(init, {
    ok: Space.toCommit({
      subject: space,
      is: {
        since: 0,
        transaction: create,
      },
    }),
  });

  const update = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [refer({ the, of: doc, is: {}, cause: refer({ the, of: doc }) }).toString()]: {
            is: { v: 1 },
          },
        },
      },
    },
  });

  assertEquals(await Space.transact(session, update), {
    ok: Space.toCommit({
      subject: space,
      is: {
        since: 1,
        transaction: update,
      },
      cause: refer(init.ok),
    }),
  });
});

test("updates memory", new URL(`memory:${space}`), async (session) => {
  const init = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [Space.init({ the, of: doc }).toString()]: {
            is: { v: 0 },
          },
        },
      },
    },
  });

  const create = await Space.transact(session, init);

  assertEquals(create, {
    ok: Space.toCommit({
      subject: space,
      is: {
        since: 0,
        transaction: init,
      },
    }),
  });

  const change = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [refer({
            the,
            of: doc,
            is: { v: 0 },
            cause: Space.init({ the, of: doc }),
          }).toString()]: {
            is: { v: 1 },
          },
        },
      },
    },
  });

  const update = await Space.transact(session, change);

  assertEquals(
    update,
    {
      ok: Space.toCommit({
        subject: space,
        is: {
          transaction: change,
          since: 1,
        },
        cause: refer(create.ok),
      }),
    },
    "updates document",
  );
});

test("fails updating non-existing memory", new URL(`memory:${space}`), async (session) => {
  const v1 = {
    the: "application/json",
    of: doc,
    is: { v: 2 },
  };

  const result = await Space.transact(
    session,
    Space.transaction({
      issuer: alice,
      subject: space,
      changes: {
        [the]: {
          [doc]: {
            [refer(v1).toString()]: {
              is: { v: 2 },
            },
          },
        },
      },
    }),
  );

  assert(result.error, "Update should fail if document does not exists");
  assert(result.error.name === "ConflictError");
  assertEquals(result.error.conflict, {
    in: space,
    the: "application/json",
    of: doc,
    expected: refer(v1),
    actual: null,
  });
});

test("create memory fails if already exists", new URL(`memory:${space}`), async (session) => {
  const base = refer({ the, of: doc });
  const create = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [base.toString()]: {
            is: { v: 0 },
          },
        },
      },
    },
  });

  const init = await Space.transact(session, create);

  assert(init.ok, "Document created");

  const createRace = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [base.toString()]: {
            is: { v: 1 },
          },
        },
      },
    },
  });

  const conflict = await Space.transact(session, createRace);

  assert(conflict.error, "Create fail when already exists");
  assert(conflict.error.name === "ConflictError");
  assertEquals(conflict.error.conflict, {
    in: space,
    the: "application/json",
    of: doc,
    expected: null,
    actual: {
      the: "application/json",
      of: doc,
      is: { v: 0 },
      cause: refer({ the: "application/json", of: doc }),
    },
  });
});

test("concurrent update fails", new URL(`memory:${space}`), async (session) => {
  const base = refer({ the, of: doc });
  const init = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [base.toString()]: {
            is: { v: 0 },
          },
        },
      },
    },
  });
  const created = {
    the,
    of: doc,
    is: { v: 0 },
    cause: base,
  };

  const create = await Space.transact(session, init);
  assert(create.ok);

  const updateA = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [space]: {
          [refer(created).toString()]: {
            is: { a: true },
          },
        },
      },
    },
  });

  const a = await Space.transact(session, updateA);

  assertEquals(
    a.ok,
    Space.toCommit({
      subject: space,
      is: {
        transaction: updateA,
        since: 1,
      },
      cause: refer(create.ok),
    }),
  );

  const updateB = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [refer(created).toString()]: {
            is: { b: true },
          },
        },
      },
    },
  });

  const b = await Space.transact(session, updateB);
  assert(b.error, "Concurrent update was rejected");
  assert(b.error.name === "ConflictError");

  assertEquals(b.error.conflict, {
    in: space,
    the: "application/json",
    of: doc,
    expected: refer(created),
    actual: {
      the: "application/json",
      of: doc,
      is: { a: true },
      cause: refer(created),
    },
  });
});

test(
  "concurrent identical memory creation succeed",
  new URL(`memory:${space}`),
  async (session) => {
    const init = Space.transaction({
      issuer: alice,
      subject: space,
      changes: {
        [the]: {
          [doc]: {
            [Space.init({ the, of: doc }).toString()]: {
              is: { this: doc },
            },
          },
        },
      },
    });
    const result = await Space.transact(session, init);
    const v0 = {
      the,
      of: doc,
      is: { this: doc },
      cause: refer({ the, of: doc }),
    };

    assertEquals(result, {
      ok: Space.toCommit({
        subject: space,
        is: {
          since: 0,
          transaction: init,
        },
      }),
    });

    const update = await Space.transact(session, init);

    assertEquals(update, {
      ok: Space.toCommit({
        subject: space,
        is: {
          since: 1,
          transaction: init,
        },
        cause: refer(result.ok),
      }),
    });
  },
);

test("concurrent identical memory updates succeed", new URL(`memory:${space}`), async (session) => {
  const v0 = { the, of: doc };

  const t0 = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [refer(v0).toString()]: {
            is: { v: 1 },
          },
        },
      },
    },
  });
  const c0 = await Space.transact(session, t0);

  assertEquals(c0, {
    ok: Space.toCommit({
      subject: space,
      is: {
        since: 0,
        transaction: t0,
      },
    }),
  });

  const v1 = {
    ...v0,
    is: { v: 1 },
    cause: refer(v0),
  };

  const t1 = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [refer(v1).toString()]: {
            is: { v: 2 },
          },
        },
      },
    },
  });

  const c1 = await Space.transact(session, t1);
  assertEquals(c1, {
    ok: Space.toCommit({
      subject: space,
      is: {
        since: 1,
        transaction: t1,
      },
      cause: refer(c0.ok),
    }),
  });

  const c2 = await Space.transact(session, t1);

  assertEquals(c2, {
    ok: Space.toCommit({
      subject: space,
      is: {
        since: 2,
        transaction: t1,
      },
      cause: refer(c1.ok),
    }),
  });
});

test("retract implicit", new URL(`memory:${space}`), async (session) => {
  const retract = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [refer({ the, of: doc }).toString()]: null,
        },
      },
    },
  });

  const retraction = await Space.transact(session, retract);

  assertEquals(retraction, {
    ok: Space.toCommit({
      subject: space,
      is: {
        since: 0,
        transaction: retract,
      },
    }),
  });

  const includeRetracted = await session.query({
    cmd: "/space/query",
    iss: alice,
    sub: space,
    args: {
      selector: {
        the,
        of: doc,
      },
    },
  });

  assertEquals(includeRetracted, {
    ok: [
      {
        the,
        of: doc,
        cause: refer({ the, of: doc }),
      },
    ],
  });

  const withoutRetracted = await session.query({
    cmd: "/space/query",
    iss: alice,
    sub: space,
    args: {
      selector: {
        the,
        of: doc,
        is: {},
      },
    },
  });

  assertEquals(withoutRetracted, {
    ok: [],
  });
});

test("retract document", new URL(`memory:${space}`), async (session) => {
  const v1 = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [refer({ the, of: doc }).toString()]: {
            is: { v: 1 },
          },
        },
      },
    },
  });
  const create = await Space.transact(session, v1);

  assert(create.ok, "Document created");
  assertEquals(
    await session.query({
      cmd: "/space/query",
      iss: alice,
      sub: space,
      args: { selector: { the: "application/json", of: doc } },
    }),
    {
      ok: [
        {
          the,
          of: doc,
          is: { v: 1 },
          cause: refer({ the, of: doc }),
        },
      ],
    },
  );

  const retract = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [refer({ the, of: doc, is: { v: 1 }, cause: { the, of: doc } }).toString()]: null,
        },
      },
    },
  });

  const drop = session.transact(retract);

  assertEquals(drop, {
    ok: Space.toCommit({
      subject: space,
      is: {
        since: 1,
        transaction: retract,
      },
      cause: refer(create.ok),
    }),
  });

  assertEquals(
    await session.query({
      cmd: "/space/query",
      iss: alice,
      sub: space,
      args: {
        selector: {
          the: "application/json",
          of: doc,
        },
      },
    }),
    {
      ok: [
        {
          the: "application/json",
          of: doc,
          cause: refer({
            the,
            of: doc,
            is: { v: 1 },
            cause: { the, of: doc },
          }),
        },
      ],
    },
    "once retracted `is` no longer included",
  );
});

test(
  "fails to retract if expected version is out of date",
  new URL(`memory:${space}`),
  async (session) => {
    const v0 = { the, of: doc };
    const v1 = { the, of: doc, is: { v: 1 }, cause: refer(v0) };
    const v2 = { the, of: doc, is: { v: 2 }, cause: refer(v1) };
    const v3 = { the, of: doc, is: { v: 3 }, cause: refer(v2) };

    const t1 = Space.transaction({
      issuer: alice,
      subject: space,
      changes: {
        [the]: {
          [doc]: {
            [refer(v0).toString()]: {
              is: { v: 1 },
            },
          },
        },
      },
    });

    const t2 = Space.transaction({
      issuer: alice,
      subject: space,
      changes: {
        [the]: {
          [doc]: {
            [refer(v1).toString()]: {
              is: { v: 2 },
            },
          },
        },
      },
    });

    const t3 = Space.transaction({
      issuer: alice,
      subject: space,
      changes: {
        [the]: {
          [doc]: {
            [refer(v2).toString()]: {
              is: { v: 3 },
            },
          },
        },
      },
    });

    assert(await session.transact(t1).ok);
    assert(await session.transact(t2).ok);
    assert(await session.transact(t3).ok);

    const result = session.transact(
      Space.transaction({
        issuer: alice,
        subject: space,
        changes: {
          [the]: {
            [doc]: {
              [refer(v1).toString()]: null, // currently it's v2 instead
            },
          },
        },
      }),
    );

    assert(result.error, "Retract fails if expected version is out of date");
    assert(result.error.name === "ConflictError");
    assertEquals(result.error.conflict, {
      the,
      in: space,
      of: doc,
      expected: refer(v1),
      actual: v3,
    });

    assertMatch(
      result.error.message,
      RegExp(
        `The application/json of ${doc} in ${space} was expected to be ${refer(
          v1,
        )}, but it is ${refer(v3)}`,
      ),
    );
  },
);

test("new memory creation fails after retraction", new URL(`memory:${alice}`), async (session) => {
  const t1 = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [refer({ the, of: doc }).toString()]: {
            is: { v: 1 },
          },
        },
      },
    },
  });

  const v1 = {
    the,
    of: doc,
    is: { v: 1 },
    cause: refer({ the, of: doc }),
  };
  const create = await Space.transact(session, t1);

  assert(create.ok, "Document created");

  const t2 = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [refer(v1).toString()]: null,
        },
      },
    },
  });

  const retract = Space.transact(session, t2);
  assertEquals(retract, {
    ok: Space.toCommit({
      subject: space,
      is: {
        since: 1,
        transaction: t2,
      },
      cause: refer(create.ok),
    }),
  });

  const t3 = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [refer({ the, of: doc }).toString()]: {
            is: { v: 2 },
          },
        },
      },
    },
  });

  const conflict = await Space.transact(session, t3);

  assert(conflict.error, "Create fails if cause not specified");
  assert(conflict.error.name === "ConflictError");
  assertEquals(conflict.error.conflict, {
    in: space,
    the,
    of: doc,
    expected: null,
    actual: {
      the: "application/json",
      of: doc,
      cause: refer(v1),
    },
  });
});

test("batch updates", new URL(`memory:${space}`), async (session) => {
  const doc2 = refer({ hi: "world" }).toString();
  const doc3 = refer({ chao: "world" }).toString();

  const doc1v0 = Space.init({ of: doc });
  const doc2v0 = Space.init({ of: doc2 });
  const tr1 = Space.transaction({
    issuer: alice,
    subject: space,
    meta: {
      message: "initialize",
    },
    changes: {
      [the]: {
        [doc]: {
          [doc1v0.toString()]: {
            is: { v: 1 },
          },
        },
        [doc2]: {
          [doc2v0.toString()]: {
            is: { v: 2 },
          },
        },
      },
    },
  });

  const doc1v1 = {
    the,
    of: doc,
    is: { v: 1 },
    cause: doc1v0,
  };

  const doc2v1 = {
    the,
    of: doc2,
    is: { v: 2 },
    cause: doc2v0,
  };

  const init = await session.transact(tr1);
  assertEquals(init, {
    ok: Space.toCommit({
      subject: space,
      is: {
        since: 0,
        transaction: tr1,
      },
    }),
  });

  assertEquals(
    await session.query({
      cmd: "/space/query",
      iss: alice,
      sub: space,
      args: {
        selector: {
          the,
          of: doc,
        },
      },
    }),
    {
      ok: [doc1v1],
    },
  );

  assertEquals(
    await session.query({
      cmd: "/space/query",
      iss: alice,
      sub: space,
      args: {
        selector: {
          the,
          of: doc2,
        },
      },
    }),
    {
      ok: [doc2v1],
    },
  );

  const doc3v0 = Space.init({ of: doc3 });

  const tr2 = Space.transaction({
    issuer: alice,
    subject: space,
    meta: {
      message: "update",
    },
    changes: {
      [the]: {
        // Update
        [doc]: {
          [refer(doc1v1).toString()]: {
            is: {
              v: 2,
            },
          },
        },
        // Ensure
        [doc2]: {
          [refer(doc2v1).toString()]: {},
        },
        [doc3]: {
          [refer(doc3v0).toString()]: {
            is: {
              doc3: { v: 1 },
            },
          },
        },
      },
    },
  });

  const update = await session.transact(tr2);
  assertEquals(update, {
    ok: Space.toCommit({
      subject: space,
      is: {
        since: 1,
        transaction: tr2,
      },
      cause: refer(init.ok),
    }),
  });

  const doc1v2 = { ...doc1v1, is: { v: 2 }, cause: refer(doc1v1) };
  assertEquals(
    await session.query({
      cmd: "/space/query",
      iss: alice,
      sub: space,
      args: {
        selector: {
          the,
          of: doc,
        },
      },
    }),
    {
      ok: [doc1v2],
    },
  );

  assertEquals(
    await session.query({
      cmd: "/space/query",
      iss: alice,
      sub: space,
      args: {
        selector: {
          the,
          of: doc2,
        },
      },
    }),
    {
      ok: [doc2v1],
    },
  );

  const doc3v1 = { the, of: doc3, is: { doc3: { v: 1 } }, cause: doc3v0 };
  assertEquals(
    await session.query({
      cmd: "/space/query",
      iss: alice,
      sub: space,
      args: {
        selector: {
          the,
          of: doc3,
        },
      },
    }),
    {
      ok: [doc3v1],
    },
  );

  // Fails on mismatched invariant

  const tr3 = Space.transaction({
    issuer: alice,
    subject: space,
    meta: {
      message: "bad invariant",
    },
    changes: {
      [the]: {
        // Out of date invariant
        [doc]: {
          [refer(doc1v1).toString()]: {},
        },
        [doc3]: {
          [refer(doc3v1).toString()]: {
            is: {
              doc3: { v: 2 },
            },
          },
        },
      },
    },
  });

  const badInvariant = session.transact(tr3);
  assert(badInvariant.error);
  assert(badInvariant.error.name == "ConflictError");
  assertEquals(badInvariant.error.conflict, {
    in: space,
    the,
    of: doc,
    expected: refer(doc1v1),
    actual: doc1v2,
  });

  assertEquals(
    await session.query({
      cmd: "/space/query",
      iss: alice,
      sub: space,
      args: {
        selector: {
          the,
          of: doc3,
        },
      },
    }),
    {
      ok: [doc3v1],
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

    const session = open.ok as Space.Store;
    const t1 = Space.transaction({
      issuer: alice,
      subject: space,
      changes: {
        [the]: {
          [doc]: {
            [refer({ the, of: doc }).toString()]: {
              is: { v: 1 },
            },
          },
        },
      },
    });
    const create = await Space.transact(session, t1);

    assertEquals(
      create,
      {
        ok: Space.toCommit({
          subject: space,
          is: {
            since: 0,
            transaction: t1,
          },
        }),
      },
      "created document",
    );

    const select = session.query({
      cmd: "/space/query",
      iss: alice,
      sub: space,
      args: {
        selector: {
          the,
          of: doc,
        },
      },
    });

    assertEquals(select, {
      ok: [
        {
          the,
          of: doc,
          is: { v: 1 },
          cause: refer({ the, of: doc }),
        },
      ],
    });
  } finally {
    await Deno.remove(url);
  }
});

test("list empty store", new URL(`memory:${space}`), async (session) => {
  const result = session.query({
    cmd: "/space/query",
    iss: alice,
    sub: space,
    args: {
      selector: {
        the: "application/json",
      },
    },
  });
  assertEquals(result, { ok: [] }, "empty list when no facts exist");
});

test("list single fact", new URL(`memory:${space}`), async (session) => {
  const tr = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [Space.init({ of: doc }).toString()]: {
            is: { v: 1 },
          },
        },
      },
    },
  });
  const write = await session.transact(tr);
  assert(write.ok);

  const result = session.query({
    cmd: "/space/query",
    iss: alice,
    sub: space,
    args: {
      selector: {
        the: "application/json",
      },
    },
  });

  assertEquals(result, {
    ok: [
      {
        the: "application/json",
        of: doc,
        is: { v: 1 },
        cause: Space.init({ of: doc }),
      },
    ],
  });
});

test("list excludes retracted facts", new URL(`memory:${space}`), async (session) => {
  // Create and then retract a fact
  const tr = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [Space.init({ of: doc }).toString()]: {
            is: { v: 1 },
          },
        },
      },
    },
  });
  const fact = await session.transact(tr);

  assert(fact.ok);
  const tr2 = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [refer({ the, of: doc, is: { v: 1 }, cause: Space.init({ of: doc }) }).toString()]: null,
        },
      },
    },
  });
  const retract = session.transact(tr2);
  assert(retract.ok);

  const result = session.query({
    cmd: "/space/query",
    iss: alice,
    sub: space,
    args: {
      selector: {
        the: "application/json",
        is: {},
      },
    },
  });

  assertEquals(result, {
    ok: [],
  });
});
