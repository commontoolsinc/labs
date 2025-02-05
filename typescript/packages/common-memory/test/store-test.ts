import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import * as Repository from "../store.ts";
import { refer, createTemporaryDirectory } from "../util.ts";

const alice = "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi";
const doc = "4301a667-5388-4477-ba08-d2e6b51a62a3";

const test = (title: string, url: URL, run: (replica: Repository.Store) => Promise<unknown>) => {
  const unit = async () => {
    const session = await Repository.open({
      url,
    });

    assert(session.ok, "Open create repository if it does not exist");

    try {
      await run(session.ok);
    } finally {
      await Repository.close(session.ok);
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
  "querying non existing memory returns implicit fact",
  new URL(`memory:${alice}`),
  async (session) => {
    const result = await Repository.query(session, {
      the: "application/json",
      of: doc,
    });

    assertEquals(
      result,
      {
        ok: {
          the: "application/json",
          of: doc,
        },
      },
      "Implicit fact",
    );
  },
);

test("create new memory", new URL(`memory:${alice}`), async (session) => {
  const v1 = {
    the: "application/json",
    of: doc,
    is: { v: 1 },
  };
  const result = await Repository.assert(session, v1);

  assertEquals(result, {
    ok: {
      the: "application/json",
      of: doc,
      is: { v: 1 },
      cause: refer({
        the: "application/json",
        of: doc,
      }),
    },
  });

  const read = Repository.query(session, {
    the: "application/json",
    of: doc,
  });

  assertEquals(read, {
    ok: {
      the: "application/json",
      of: doc,
      is: { v: 1 },
      cause: refer({
        the: "application/json",
        of: doc,
      }),
    },
  });
});

test("explicit empty creation", new URL(`memory:${alice}`), async (session) => {
  assertEquals(await Repository.query(session, { the: "application/json", of: doc }), {
    ok: {
      the: "application/json",
      of: doc,
    },
  });

  const blank = { the: "application/json", of: doc, is: {} };

  assert(await Repository.assert(session, blank).ok);
  assert(await Repository.assert(session, blank).ok);

  assertEquals(await Repository.query(session, { the: "application/json", of: doc }), {
    ok: {
      the: "application/json",
      of: doc,
      is: {},
      cause: refer({
        the: "application/json",
        of: doc,
      }),
    },
  });
});

test("assert with explicit default cause", new URL(`memory:${alice}`), async (session) => {
  const result = await Repository.assert(session, {
    the: "application/json",
    of: doc,
    is: { v: 1 },
    cause: refer({
      the: "application/json",
      of: doc,
    }),
  });

  assertEquals(result, {
    ok: {
      the: "application/json",
      of: doc,
      is: { v: 1 },
      cause: refer({
        the: "application/json",
        of: doc,
      }),
    },
  });
});

test("explicit {}", new URL(`memory:${alice}`), async (session) => {
  const create = await Repository.assert(session, {
    the: "application/json",
    of: doc,
    is: {},
  });

  assertEquals(create, {
    ok: {
      the: "application/json",
      of: doc,
      is: {},
      cause: refer({
        the: "application/json",
        of: doc,
      }),
    },
  });

  const update = await Repository.assert(session, {
    the: "application/json",
    of: doc,
    is: { v: 1 },
    cause: refer(create.ok),
  });

  assertEquals(update, {
    ok: {
      the: "application/json",
      of: doc,
      is: { v: 1 },
      cause: refer(create.ok),
    },
  });
});

test("updates memory", new URL(`memory:${alice}`), async (session) => {
  const v0 = {
    the: "application/json",
    of: doc,
    is: { v: 0 },
  };

  const create = await Repository.assert(session, v0);

  assert(create.ok, "Document asserted");
  assertEquals(create, {
    ok: {
      the: "application/json",
      of: doc,
      is: { v: 0 },
      cause: refer({
        the: "application/json",
        of: doc,
      }),
    },
  });

  const update = await Repository.assert(session, {
    the: "application/json",
    of: doc,
    is: { v: 1 },
    cause: refer({
      the: "application/json",
      of: doc,
      is: { v: 0 },
      cause: refer({
        the: "application/json",
        of: doc,
      }),
    }),
  });

  assertEquals(
    update,
    {
      ok: {
        the: "application/json",
        of: doc,
        is: { v: 1 },
        cause: refer({
          the: "application/json",
          of: doc,
          is: { v: 0 },
          cause: refer({
            the: "application/json",
            of: doc,
          }),
        }),
      },
    },
    "updates document",
  );
});

test("fails updating non-existing memory", new URL(`memory:${alice}`), async (session) => {
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
  assertEquals(result.error.conflict, {
    in: alice,
    the: "application/json",
    of: doc,
    expected: refer(v1),
    actual: null,
  });
});

test("create memory fails if already exists", new URL(`memory:${alice}`), async (session) => {
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
  assertEquals(conflict.error.conflict, {
    in: alice,
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

test("concurrent update fails", new URL(`memory:${alice}`), async (session) => {
  const init = {
    the: "application/json",
    of: doc,
    is: { v: 0 },
  };
  const base = {
    ...init,
    cause: refer({ the: "application/json", of: doc }),
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
    the: "application/json",
    of: doc,
    is: { a: true },
    cause: refer(base),
  });

  assert(b.error, "Concurrent update was rejected");
  assert(b.error.name === "ConflictError");
  assertEquals(b.error.conflict, {
    in: alice,
    the: "application/json",
    of: doc,
    expected: refer(base),
    actual: {
      the: "application/json",
      of: doc,
      is: { a: true },
      cause: refer(base),
    },
  });
});

test(
  "concurrent identical memory creation succeed",
  new URL(`memory:${alice}`),
  async (session) => {
    const result = await Repository.assert(session, {
      the: "application/json",
      of: doc,
      is: { this: doc },
    });

    assertEquals(result, {
      ok: {
        the: "application/json",
        of: doc,
        is: { this: doc },
        cause: refer({ the: "application/json", of: doc }),
      },
    });

    const update = await Repository.assert(session, {
      the: "application/json",
      of: doc,
      is: { this: doc },
      cause: refer(result.ok),
    });

    assertEquals(update, {
      ok: {
        the: "application/json",
        of: doc,
        is: { this: doc },
        cause: refer(result.ok),
      },
    });
  },
);

test("concurrent identical memory updates succeed", new URL(`memory:${alice}`), async (session) => {
  const seed = {
    the: "application/json",
    of: doc,
    is: { v: 0 },
  };

  const v0 = {
    ...seed,
    cause: refer({
      the: "application/json",
      of: doc,
    }),
  };

  assert(await Repository.assert(session, seed).ok);

  const first = await Repository.assert(session, {
    the: "application/json",
    of: doc,
    is: { v: 1 },
    cause: refer(v0),
  });

  assertEquals(first, {
    ok: {
      the: "application/json",
      of: doc,
      is: { v: 1 },
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
      the: "application/json",
      of: doc,
      is: { v: 1 },
      cause: refer(v0),
    },
  });
});

test("retract implicit", new URL(`memory:${alice}`), async (session) => {
  // @ts-expect-error - can not retract non-existing assertion.
  const retract = await Repository.retract(session, {
    the: "application/json",
    of: doc,
  });

  assertEquals(retract, {
    ok: {
      the: "application/json",
      of: doc,
      cause: Repository.init({
        the: "application/json",
        of: doc,
      }),
    },
  });
});

test("retract document", new URL(`memory:${alice}`), async (session) => {
  const v0 = {
    the: "application/json",
    of: doc,
    is: { v: 0 },
  };
  const create = await Repository.assert(session, v0);

  assert(create.ok, "Document created");
  assertEquals(await session.query({ the: "application/json", of: doc }), {
    ok: {
      ...v0,
      cause: Repository.init({ the: "application/json", of: doc }),
    },
  });

  const drop = session.transact({
    retract: {
      the: "application/json",
      of: doc,
      is: { v: 0 },
      cause: Repository.init({
        the: "application/json",
        of: doc,
      }),
    },
  });

  assert(drop.ok, "Document retracted");

  assertEquals(drop, {
    ok: {
      the: "application/json",
      of: doc,
      cause: refer(create.ok),
    },
  });

  const read = await session.query({ the: "application/json", of: doc });
  assertEquals(
    read,
    {
      ok: {
        the: "application/json",
        of: doc,
        cause: refer(create.ok),
      },
    },
    "once retracted `is` no longer included",
  );
});

test(
  "fails to retract if expected version is out of date",
  new URL(`memory:${alice}`),
  async (session) => {
    const base = {
      the: "application/json",
      of: doc,
      is: { v: 0 },
    };

    const v0 = {
      ...base,
      cause: Repository.init(base),
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

    const result = session.transact({ retract: v1 });

    assert(result.error, "Retract fails if expected version is out of date");
    assert(result.error.name === "ConflictError");
    assertEquals(result.error.conflict, {
      in: alice,
      the: "application/json",
      of: doc,
      expected: refer(v1),
      actual: v2,
    });

    assertMatch(
      result.error.message,
      RegExp(
        `The application/json of ${doc} in ${alice} was expected to be ${refer(
          v1,
        )}, but it is ${refer(v2)}`,
      ),
    );
  },
);

test("new memory creation fails after retraction", new URL(`memory:${alice}`), async (session) => {
  const v0 = {
    the: "application/json",
    of: doc,
    is: { v: 0 },
  };
  const create = await Repository.assert(session, v0);

  assert(create.ok, "Document created");

  const retract = Repository.retract(session, create.ok);
  assert(retract.ok, "Document retracted");

  const conflict = await Repository.assert(session, {
    the: "application/json",
    of: doc,
    is: { v: 1 },
  });

  assert(conflict.error, "Create fails if cause not specified");
  assert(conflict.error.name === "ConflictError");
  assertEquals(conflict.error.conflict, {
    in: alice,
    the: "application/json",
    of: doc,
    expected: null,
    actual: {
      the: "application/json",
      of: doc,
      cause: refer(create.ok),
    },
  });
});

Deno.test("fail to connect to non-existing replica", async () => {
  const url = new URL(`./${alice}.sqlite`, await createTemporaryDirectory());
  const session = await Repository.connect({ url });

  await assert(session.error, "Replica does not exist");

  if (session.error) {
    assertEquals(session.error.name, "ConnectionError");
    assertEquals(session.error.address, url.href);
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
          the: "application/json",
          of: doc,
          is: { v: 0 },
          cause: refer({ the: "application/json", of: doc }),
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
      cause: refer({ the: "application/json", of: doc }),
    });
  } finally {
    await Deno.remove(url);
  }
});

test("list empty store", new URL(`memory:${alice}`), async (session) => {
  const result = session.list("application/json");
  assertEquals(result, { ok: [] }, "empty list when no facts exist");
});

test("list single fact", new URL(`memory:${alice}`), async (session) => {
  session.transact({
    assert: {
      the: "application/json",
      of: doc,
      is: { v: 1 },
    },
  });

  const result = session.list({ the: "application/json" });
  assertEquals(result, {
    ok: [
      {
        of: doc,
        is: { v: 1 },
        the: "application/json",
      },
    ],
  });
});

test("list excludes retracted facts", new URL(`memory:${alice}`), async (session) => {
  // Create and then retract a fact
  const fact = session.transact({
    assert: {
      the: "application/json",
      of: doc,
      is: { v: 1 },
    },
  });

  assert(fact.ok);
  session.transact({ retract: fact.ok });

  const result = session.list({ the: "application/json" });
  assertEquals(result, {
    ok: [],
  });
});
