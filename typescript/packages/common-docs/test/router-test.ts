import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import * as Router from "../router.ts";
import { refer } from "merkle-reference";

const alice = "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi";
const bob = "did:key:z6MkffDZCkCTWreg8868fG1FGFogcJj5X6PY93pPcWDn9bob";
const doc = "4301a667-5388-4477-ba08-d2e6b51a62a3";

const test = (
  title: string,
  url: URL,
  run: (replica: Router.Session) => Promise<unknown>,
) => {
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

test("query non-existing", memory, async session => {
  const unclaimed = await session.query({
    the: "application/json",
    of: doc,
    in: alice,
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

test("create new memory", memory, async session => {
  const v1 = {
    the: "application/json",
    of: doc,
    is: { v: 1 },
  };

  const result = await session.transact({ assert: v1, in: alice });
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
      in: alice,
      the: "application/json",
      of: doc,
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
      in: bob,
      the: "application/json",
      of: doc,
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

test("create memory fails if already exists", memory, async session => {
  const create = await session.transact({
    in: alice,
    assert: {
      the: "application/json",
      of: doc,
      is: { v: 0 },
    },
  });

  assert(create.ok, "Document created");

  const conflict = await session.transact({
    in: alice,
    assert: {
      the: "application/json",
      of: doc,
      is: { v: 1 },
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
