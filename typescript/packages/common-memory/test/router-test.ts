import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import * as Router from "../router.ts";
import { refer } from "merkle-reference";

const alice = "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi";
const bob = "did:key:z6MkffDZCkCTWreg8868fG1FGFogcJj5X6PY93pPcWDn9bob";
const doc = "4301a667-5388-4477-ba08-d2e6b51a62a3";

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
    [alice]: {
      the: "application/json",
      of: doc,
    },
  });

  assertEquals(
    unclaimed,
    {
      ok: {
        the: "application/json",
        of: doc,
      },
    },
    "return unclaimed fact",
  );
});

test("create new memory", memory, async (session) => {
  const v1 = {
    the: "application/json",
    of: doc,
    is: { v: 1 },
  };

  const result = await session.transact({ [alice]: { assert: v1 } });
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

  assertEquals(
    await session.query({
      [alice]: {
        the: "application/json",
        of: doc,
      },
    }),
    {
      ok: {
        the: "application/json",
        of: doc,
        is: { v: 1 },
        cause: refer({
          the: "application/json",
          of: doc,
        }),
      },
    },
    "fact was added to the memory",
  );

  assertEquals(
    await session.query({
      [bob]: {
        the: "application/json",
        of: doc,
      },
    }),
    {
      ok: {
        the: "application/json",
        of: doc,
      },
    },
    "fact is unclaimed in other memory space",
  );
});

test("create memory fails if already exists", memory, async (session) => {
  const create = await session.transact({
    [alice]: {
      assert: {
        the: "application/json",
        of: doc,
        is: { v: 0 },
      },
    },
  });

  assert(create.ok, "Document created");

  const conflict = await session.transact({
    [alice]: {
      assert: {
        the: "application/json",
        of: doc,
        is: { v: 1 },
      },
    },
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

// List tests

test("list empty memory", memory, async (session) => {
  const result = await session.query({
    [alice]: { the: "application/json" },
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
    [alice]: {
      assert: {
        the: "application/json",
        of: doc,
        is: { v: 1 },
      },
    },
  });

  const result = await session.query({
    [alice]: { the: "application/json" },
  });

  assertEquals(
    result,
    {
      ok: [
        {
          of: doc,
          is: { v: 1 },
          the: "application/json",
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
    [alice]: {
      assert: {
        the: "application/json",
        of: doc,
        is: { v: 1 },
      },
    },
  });

  await session.transact({
    [alice]: {
      assert: {
        the: "application/json",
        of: doc2,
        is: { v: 2 },
      },
    },
  });

  const result = await session.query({
    [alice]: { the: "application/json" },
  });

  assertEquals(
    result,
    {
      ok: [
        {
          of: doc,
          is: { v: 1 },
          the: "application/json",
        },
        {
          of: doc2,
          is: { v: 2 },
          the: "application/json",
        },
      ],
    },
    "lists multiple facts",
  );
});

test("list excludes retracted facts", memory, async (session) => {
  // First create and then retract a fact
  await session.transact({
    [alice]: {
      assert: {
        the: "application/json",
        of: doc,
        is: { v: 1 },
      },
    },
  });

  const fact = (
    await session.query({
      [alice]: {
        the: "application/json",
        of: doc,
      },
    })
  ).ok;

  await session.transact({
    [alice]: {
      retract: fact,
    },
  });

  const result = await session.query({
    [alice]: { the: "application/json" },
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
  // Create facts of different types
  await session.transact({
    [alice]: {
      assert: {
        the: "application/json",
        of: doc,
        is: { v: 1 },
      },
    },
  });

  await session.transact({
    [alice]: {
      assert: {
        the: "text/plain",
        of: doc,
        is: "Hello",
      },
    },
  });

  const jsonResult = await session.query({
    [alice]: { the: "application/json" },
  });

  const textResult = await session.query({
    [alice]: { the: "text/plain" },
  });

  assertEquals(
    jsonResult,
    {
      ok: [
        {
          of: doc,
          is: { v: 1 },
          the: "application/json",
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
          of: doc,
          is: "Hello",
          the: "text/plain",
        },
      ],
    },
    "lists text facts",
  );
});

test("list facts from different replicas", memory, async (session) => {
  // Create facts in different replica spaces
  await session.transact({
    [alice]: {
      assert: {
        the: "application/json",
        of: doc,
        is: { v: 1 },
      },
    },
  });

  await session.transact({
    [bob]: {
      assert: {
        the: "application/json",
        of: doc,
        is: { v: 2 },
      },
    },
  });

  const aliceResult = await session.query({
    [alice]: { the: "application/json" },
  });

  const bobResult = await session.query({
    [bob]: { the: "application/json" },
  });

  assertEquals(
    aliceResult,
    {
      ok: [
        {
          of: doc,
          is: { v: 1 },
          the: "application/json",
        },
      ],
    },
    "lists alice's facts",
  );

  assertEquals(
    bobResult,
    {
      ok: [
        {
          of: doc,
          is: { v: 2 },
          the: "application/json",
        },
      ],
    },
    "lists bob's facts",
  );
});

test("list from non-existent replica", memory, async (session) => {
  const result = await session.query({
    [alice]: { the: "application/json" },
  });
  assertEquals(result, { ok: [] }, "empty list from new replica");
});

test("list from multiple replicas", memory, async (session) => {
  // Create facts in different replicas
  await session.transact({
    [alice]: {
      assert: {
        the: "application/json",
        of: doc,
        is: { v: 1 },
      },
    },
  });

  await session.transact({
    [bob]: {
      assert: {
        the: "application/json",
        of: doc,
        is: { v: 2 },
      },
    },
  });

  const aliceResult = await session.query({
    [alice]: { the: "application/json" },
  });

  const bobResult = await session.query({
    [bob]: { the: "application/json" },
  });

  assertEquals(
    aliceResult,
    {
      ok: [{ of: doc, is: { v: 1 }, the: "application/json" }],
    },
    "lists alice's facts",
  );

  assertEquals(
    bobResult,
    {
      ok: [{ of: doc, is: { v: 2 }, the: "application/json" }],
    },
    "lists bob's facts",
  );
});
