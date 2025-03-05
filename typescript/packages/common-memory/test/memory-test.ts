import { assert, assertEquals, assertMatch } from "@std/assert";
import * as Memory from "../memory.ts";
import * as Fact from "../fact.ts";
import * as Transaction from "../transaction.ts";
import * as Changes from "../changes.ts";
import * as Commit from "../commit.ts";
import * as Query from "../query.ts";
import { refer } from "merkle-reference";

const alice = "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi";
const bob = "did:key:z6MkffDZCkCTWreg8868fG1FGFogcJj5X6PY93pPcWDn9bob";
const space = bob;
const doc = `of:${refer({ hello: "world" })}` as const;
const the = "application/json";

const test = (
  title: string,
  url: URL,
  run: (replica: Memory.MemorySession) => Promise<unknown>,
) => {
  const unit = async () => {
    const open = await Memory.open({
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
  const unclaimed = await session.query(
    Query.create({
      issuer: alice,
      subject: space,
      select: { [doc]: { [the]: {} } },
    }),
  );

  assertEquals(
    unclaimed,
    {
      ok: { [space]: { [doc]: { [the]: {} } } },
    },
    "no matching facts",
  );
});

test("create new memory", memory, async (session) => {
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

  const result = await session.transact(tr1);
  assert(result.ok);
  const c1 = Commit.create({
    space,
    transaction: tr1,
  });

  assertEquals(result, { ok: Changes.from([c1]) });

  assertEquals(
    await session.query(
      Query.create({
        issuer: alice,
        subject: space,
        select: { [doc]: { [the]: {} } },
      }),
    ),
    {
      ok: { [space]: Changes.from([v1]) },
    },
    "fact was added to the memory",
  );

  assertEquals(
    await session.query(
      Query.create({
        issuer: alice,
        subject: alice,
        select: { [doc]: { [the]: {} } },
      }),
    ),
    {
      ok: { [alice]: { [doc]: { [the]: {} } } },
    },
    "fact is unclaimed in another memory space",
  );
});

test("create memory fails if already exists", memory, async (session) => {
  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
  const create = await session.transact(
    Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([v1]),
    }),
  );

  assert(create.ok, "Document created");

  const v2 = Fact.assert({ the, of: doc, is: { fork: true } });

  const conflict = await session.transact(
    Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([v2]),
    }),
  );

  assert(conflict.error, "Create fail when already exists");
  assert(conflict.error.name === "ConflictError");
  assertEquals(conflict.error.conflict, {
    space,
    the,
    of: doc,
    expected: null,
    actual: v1,
  });
});

// List tests

test("list empty memory", memory, async (session) => {
  const result = await session.query(
    Query.create({
      issuer: alice,
      subject: space,
      select: { _: { [the]: {} } },
    }),
  );

  assertEquals(
    result,
    {
      ok: { [space]: {} },
    },
    "no facts exist",
  );
});

test("list single fact", memory, async (session) => {
  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
  // First create a fact
  await session.transact(
    Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([v1]),
    }),
  );

  const result = await session.query(
    Query.create({
      issuer: alice,
      subject: space,
      select: { _: { [the]: {} } },
    }),
  );

  assertEquals(
    result,
    {
      ok: { [space]: Changes.from([v1]) },
    },
    "lists single fact",
  );
});

test("list multiple facts", memory, async (session) => {
  const doc2 = `of:${refer({ doc: 2 })}` as const;

  const facts = [
    Fact.assert({ the, of: doc, is: { v: 1 } }),
    Fact.assert({ the, of: doc2, is: { v: 2 } }),
  ];

  // Create multiple facts
  await session.transact(
    Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from(facts),
    }),
  );

  const result = await session.query(
    Query.create({
      issuer: alice,
      subject: space,
      select: { _: { [the]: {} } },
    }),
  );

  assertEquals(
    result,
    {
      ok: { [space]: Changes.from(facts) },
    },
    "lists multiple facts",
  );
});

test("list excludes retracted facts", memory, async (session) => {
  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
  // First create and then retract a fact
  await session.transact(
    Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([v1]),
    }),
  );

  assertEquals(
    await session.query(
      Query.create({
        issuer: alice,
        subject: space,
        select: { [doc]: { [the]: {} } },
      }),
    ),
    {
      ok: { [space]: Changes.from([v1]) },
    },
  );

  const v2 = Fact.retract(v1);

  await session.transact(
    Transaction.create({
      issuer: alice,
      subject: space,
      changes: Changes.from([v2]),
    }),
  );

  const result = await session.query(
    Query.create({
      issuer: alice,
      subject: space,
      select: {
        [doc]: {
          [the]: {
            is: {},
          },
        },
      },
    }),
  );

  assertEquals(
    result,
    {
      ok: { [space]: { [doc]: { [the]: {} } } },
    },
    "excludes retracted facts with undefined value",
  );
});

test("list different fact types", memory, async (session) => {
  const json = Fact.assert({ the, of: doc, is: { v: 1 } });
  const text = Fact.assert({ the: "text/plain", of: doc, is: "Hello" });

  const tr = Transaction.create({
    issuer: alice,
    subject: space,
    changes: Changes.from([json, text]),
  });

  // Create facts of different types
  await session.transact(tr);

  const jsonResult = await session.query(
    Query.create({
      issuer: alice,
      subject: space,
      select: { _: { [the]: {} } },
    }),
  );

  const textResult = await session.query(
    Query.create({
      issuer: alice,
      subject: space,
      select: { _: { ["text/plain"]: {} } },
    }),
  );

  assertEquals(
    jsonResult,
    {
      ok: { [space]: Changes.from([json]) },
    },
    "lists json facts",
  );

  assertEquals(
    textResult,
    {
      ok: {
        [space]: Changes.from([text]),
      },
    },
    "lists text facts",
  );
});

test("list facts from different replicas", memory, async (session) => {
  const a = Fact.assert({ the, of: doc, is: { v: 1 } });
  const b = Fact.assert({ the, of: doc, is: { v: 2 } });

  // Create facts in different replica spaces
  await session.transact(
    Transaction.create({
      issuer: alice,
      subject: alice,
      changes: Changes.from([a]),
    }),
  );

  await session.transact(
    Transaction.create({
      issuer: alice,
      subject: bob,
      changes: Changes.from([b]),
    }),
  );

  const aliceResult = await session.query(
    Query.create({
      issuer: alice,
      subject: alice,
      select: { [doc]: {} },
    }),
  );

  const bobResult = await session.query(
    Query.create({
      issuer: alice,
      subject: bob,
      select: { [doc]: {} },
    }),
  );

  assertEquals(
    aliceResult,
    {
      ok: { [alice]: Changes.from([a]) },
    },
    "lists alice's facts",
  );

  assertEquals(
    bobResult,
    {
      ok: { [bob]: Changes.from([b]) },
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
      select: {
        _: {},
      },
    },
    prf: [],
  });
  assertEquals(result, { ok: { [space]: {} } }, "empty list from new replica");
});
