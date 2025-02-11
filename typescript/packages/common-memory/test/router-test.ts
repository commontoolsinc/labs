import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import * as Router from "../router.ts";
import * as Space from "../space.ts";
import { refer } from "merkle-reference";

const alice = "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi";
const space = "did:key:z6MkffDZCkCTWreg8868fG1FGFogcJj5X6PY93pPcWDn9bob";
const doc = refer({ hello: "world" }).toString();
const the = "application/json";

const test = (title: string, url: URL, run: (replica: Router.Session) => Promise<unknown>) => {
  const unit = async () => {
    const open = await Router.open({
      store: url,
    });

    assert(open.ok, "Open create repository if it does not exist");
    const session = open.ok;

    try {
      await run(session);
    } finally {
      await session.close();
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

const memory = new URL(`memory://`);

test("query non-existing", memory, async (session) => {
  const unclaimed = await session.query({
    iss: alice,
    sub: space,
    cmd: "/memory/query",
    args: {
      selector: {
        the: "application/json",
        of: doc,
      },
    },
  });

  assertEquals(
    unclaimed,
    {
      ok: [],
    },
    "no matching facts",
  );
});

test("create new memory", memory, async (session) => {
  const v1 = {
    the: "application/json",
    of: doc,
    is: { v: 1 },
  };

  const tr1 = {
    iss: alice,
    sub: space,
    cmd: "/memory/transact" as const,
    args: {
      changes: {
        [the]: {
          [doc]: {
            [refer({ the, of: doc }).toString()]: {
              is: { v: 1 },
            },
          },
        },
      },
    },
  };

  const result = await session.transact(tr1);

  assertEquals(result, {
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
      cmd: "/memory/query",
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
      ok: [
        {
          the,
          of: doc,
          is: { v: 1 },
          cause: refer({
            the,
            of: doc,
          }),
        },
      ],
    },
    "fact was added to the memory",
  );

  assertEquals(
    await session.query({
      cmd: "/memory/query",
      iss: alice,
      sub: alice,
      args: {
        selector: {
          the,
          of: doc,
        },
      },
    }),
    {
      ok: [],
    },
    "fact is unclaimed in other memory space",
  );
});

test("create memory fails if already exists", memory, async (session) => {
  const create = await session.transact({
    cmd: "/memory/transact",
    iss: alice,
    sub: space,
    args: {
      changes: {
        [the]: {
          [doc]: {
            [Space.init({ the, of: doc }).toString()]: {
              is: { v: 0 },
            },
          },
        },
      },
    },
  });

  assert(create.ok, "Document created");

  const conflict = await session.transact({
    cmd: "/memory/transact",
    iss: alice,
    sub: space,
    args: {
      changes: {
        [the]: {
          [doc]: {
            [Space.init({ the, of: doc }).toString()]: {
              is: { v: 1 },
            },
          },
        },
      },
    },
  });

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
      cause: refer({ the, of: doc }),
    },
  });
});

// List tests

test("list empty memory", memory, async (session) => {
  const result = await session.query({
    iss: alice,
    sub: space,
    cmd: "/memory/query",
    args: {
      selector: {
        the,
      },
    },
  });

  assertEquals(
    result,
    {
      ok: [],
    },
    "empty list when no facts exist",
  );
});

test("list single fact", memory, async (session) => {
  // First create a fact
  await session.transact({
    cmd: "/memory/transact",
    iss: alice,
    sub: space,
    args: {
      changes: {
        [the]: {
          [doc]: {
            [Space.init({ the, of: doc }).toString()]: {
              is: { v: 1 },
            },
          },
        },
      },
    },
  });

  const result = await session.query({
    cmd: "/memory/query",
    iss: alice,
    sub: space,
    args: {
      selector: { the },
    },
  });

  assertEquals(
    result,
    {
      ok: [
        {
          the,
          of: doc,
          is: { v: 1 },
          cause: Space.init({ the, of: doc }),
        },
      ],
    },
    "lists single fact",
  );
});

test("list multiple facts", memory, async (session) => {
  const doc2 = "second-doc-uuid";

  // Create multiple facts
  await session.transact({
    cmd: "/memory/transact",
    iss: alice,
    sub: space,
    args: {
      changes: {
        [the]: {
          [doc]: {
            [Space.init({ the, of: doc }).toString()]: {
              is: { v: 1 },
            },
          },
          [doc2]: {
            [Space.init({ the, of: doc2 }).toString()]: {
              is: { v: 2 },
            },
          },
        },
      },
    },
  });

  const result = await session.query({
    cmd: "/memory/query",
    iss: alice,
    sub: space,
    args: {
      selector: { the: "application/json" },
    },
  });

  assertEquals(
    result,
    {
      ok: [
        {
          the: "application/json",
          of: doc,
          is: { v: 1 },
          cause: Space.init({ the, of: doc }),
        },
        {
          the: "application/json",
          of: doc2,
          is: { v: 2 },
          cause: Space.init({ the, of: doc2 }),
        },
      ],
    },
    "lists multiple facts",
  );
});

test("list excludes retracted facts", memory, async (session) => {
  // First create and then retract a fact
  await session.transact({
    cmd: "/memory/transact",
    iss: alice,
    sub: space,
    args: {
      changes: {
        [the]: {
          [doc]: {
            [Space.init({ the, of: doc }).toString()]: {
              is: { v: 1 },
            },
          },
        },
      },
    },
  });

  assertEquals(
    await session.query({
      cmd: "/memory/query",
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
      ok: [
        {
          the,
          of: doc,
          is: { v: 1 },
          cause: Space.init({ the, of: doc }),
        },
      ],
    },
  );

  await session.transact({
    cmd: "/memory/transact",
    iss: alice,
    sub: space,
    args: {
      changes: {
        [the]: {
          [doc]: {
            [refer({ is: { v: 1 }, cause: Space.init({ the, of: doc }) }).toString()]: null,
          },
        },
      },
    },
  });

  const result = await session.query({
    cmd: "/memory/query",
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

  assertEquals(
    result,
    {
      ok: [],
    },
    "excludes retracted facts with undefined value",
  );
});

test("list different fact types", memory, async (session) => {
  const tr = {
    cmd: "/memory/transact",
    iss: alice,
    sub: space,
    args: {
      changes: {
        [the]: {
          [doc]: {
            [Space.init({ the, of: doc }).toString()]: {
              is: { v: 1 },
            },
          },
        },
        ["text/plain"]: {
          [doc]: {
            [Space.init({ the: "text/plain", of: doc }).toString()]: {
              is: "Hello",
            },
          },
        },
      },
    },
  } as const;
  // Create facts of different types
  await session.transact(tr);

  const jsonResult = await session.query({
    cmd: "/memory/query",
    iss: alice,
    sub: space,
    args: {
      selector: {
        the,
      },
    },
  });

  const textResult = await session.query({
    cmd: "/memory/query",
    iss: alice,
    sub: space,
    args: {
      selector: {
        the: "text/plain",
      },
    },
  });

  assertEquals(
    jsonResult,
    {
      ok: [
        {
          the: "application/json",
          of: doc,
          is: { v: 1 },
          cause: Space.init({ the, of: doc }),
        },
      ],
    },
    "lists json facts",
  );

  assertEquals(
    textResult,
    {
      ok: [
        {
          the: "text/plain",
          of: doc,
          is: "Hello",
          cause: Space.init({ the: "text/plain", of: doc }),
        },
      ],
    },
    "lists text facts",
  );
});

test("list facts from different replicas", memory, async (session) => {
  // Create facts in different replica spaces
  await session.transact({
    cmd: "/memory/transact",
    iss: alice,
    sub: space,
    args: {
      changes: {
        [the]: {
          [doc]: {
            [Space.init({ the, of: doc }).toString()]: {
              is: { v: 1 },
            },
          },
        },
      },
    },
  });

  await session.transact({
    cmd: "/memory/transact",
    iss: alice,
    sub: alice,
    args: {
      changes: {
        [the]: {
          [doc]: {
            [Space.init({ the, of: doc }).toString()]: {
              is: { v: 2 },
            },
          },
        },
      },
    },
  });

  const spaceResult = await session.query({
    cmd: "/memory/query",
    iss: alice,
    sub: space,
    args: {
      selector: {
        the,
      },
    },
  });

  const aliceResult = await session.query({
    cmd: "/memory/query",
    iss: alice,
    sub: alice,
    args: {
      selector: {
        the,
      },
    },
  });

  assertEquals(
    spaceResult,
    {
      ok: [
        {
          the: "application/json",
          of: doc,
          is: { v: 1 },
          cause: Space.init({ the, of: doc }),
        },
      ],
    },
    "lists alice's facts",
  );

  assertEquals(
    aliceResult,
    {
      ok: [
        {
          the: "application/json",
          of: doc,
          is: { v: 2 },
          cause: Space.init({ the, of: doc }),
        },
      ],
    },
    "lists bob's facts",
  );
});

test("list from non-existent replica", memory, async (session) => {
  const result = await session.query({
    cmd: "/memory/query",
    iss: alice,
    sub: space,
    args: {
      selector: {
        the,
      },
    },
  });
  assertEquals(result, { ok: [] }, "empty list from new replica");
});
