import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import * as Router from "../router.ts";
import { refer } from "../lib.ts";

const alice = "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi";
const bob = "did:key:z6MkffDZCkCTWreg8868fG1FGFogcJj5X6PY93pPcWDn9bob";
const doc = "4301a667-5388-4477-ba08-d2e6b51a62a3";
const doc2 = "2959ac6c-be22-495e-aa5b-b52bd101d354";

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

test("subscribe receives unclaimed state", memory, async session => {
  const subscription = session.subscribe({
    [alice]: {
      the: "application/json",
      of: doc,
    },
  });

  const [unclaimed] = await take(subscription.stream, 1);

  assertEquals(
    unclaimed,
    {
      [alice]: {
        the: "application/json",
        of: doc,
      },
    },
    "receives unclaimed fact",
  );
});

test("subscribe receives unclaimed then asserted", memory, async session => {
  const subscription = session.subscribe({
    [alice]: {
      the: "application/json",
      of: doc,
    },
  });

  session.transact({
    [alice]: {
      assert: {
        the: "application/json",
        of: doc,
        is: { v: 1 },
      },
    },
  });

  const updates = await take(subscription.stream, 2);

  assertEquals(updates, [
    {
      [alice]: {
        the: "application/json",
        of: doc,
      },
    },
    {
      [alice]: {
        the: "application/json",
        of: doc,
        is: { v: 1 },
        cause: refer({ the: "application/json", of: doc }),
      },
    },
  ]);
});

test("subscribe receives retraction", memory, async session => {
  await session.transact({
    [alice]: {
      assert: {
        the: "application/json",
        of: doc,
        is: { v: 1 },
      },
    },
  });

  const subscription = session.subscribe({
    [alice]: {
      the: "application/json",
      of: doc,
    },
  });

  const retract = await session.transact({
    [alice]: {
      retract: {
        the: "application/json",
        of: doc,
        is: { v: 1 },
        cause: refer({ the: "application/json", of: doc }),
      },
    },
  });

  assert(retract.ok, "retracted");

  const updates = await take(subscription.stream, 2);
  assertEquals(updates, [
    {
      [alice]: {
        the: "application/json",
        of: doc,
        is: { v: 1 },
        cause: refer({ the: "application/json", of: doc }),
      },
    },
    {
      [alice]: {
        the: "application/json",
        of: doc,
        cause: refer({
          the: "application/json",
          of: doc,
          is: { v: 1 },
          cause: refer({ the: "application/json", of: doc }),
        }),
      },
    },
  ]);
});

test("subscription watch / unwatch", memory, async session => {
  const subscription = session.subscribe({
    [alice]: {
      the: "application/json",
      of: doc,
    },
  });

  const two = take(subscription.stream, 2);

  const v1 = await session.transact({
    [alice]: {
      assert: {
        the: "application/json",
        of: doc2,
        is: { v: 1 },
      },
    },
  });

  assert(v1.ok, "asserted second doc");

  await session.transact({
    [alice]: {
      assert: {
        the: "application/json",
        of: doc,
        is: { v: 2 },
      },
    },
  });

  assertEquals(
    await two,
    [
      {
        [alice]: {
          the: "application/json",
          of: doc,
        },
      },
      {
        [alice]: {
          the: "application/json",
          of: doc,
          is: { v: 2 },
          cause: refer({ the: "application/json", of: doc }),
        },
      },
    ],
    "did not got update for the document was not subscribed to",
  );

  const next = take(subscription.stream, 1);
  subscription.watch({ [alice]: { the: "application/json", of: doc2 } });

  assertEquals(
    await next,
    [
      {
        [alice]: {
          the: "application/json",
          of: doc2,
          is: { v: 1 },
          cause: refer({ the: "application/json", of: doc2 }),
        },
      },
    ],
    "got update for the document was subscribed to",
  );

  subscription.unwatch({ [alice]: { the: "application/json", of: doc } });

  const third = take(subscription.stream, 1);

  const v3 = await session.transact({
    [alice]: {
      assert: {
        the: "application/json",
        of: doc,
        is: { v: 3 },
        cause: refer({
          the: "application/json",
          of: doc,
          is: { v: 2 },
          cause: {
            the: "application/json",
            of: doc,
          },
        }),
      },
    },
  });
  assert(v3.ok);

  const v4 = await session.transact({
    [alice]: {
      assert: {
        the: "application/json",
        of: doc2,
        is: { v: 4 },
        cause: refer({
          the: "application/json",
          of: doc2,
          is: { v: 1 },
          cause: { the: "application/json", of: doc2 },
        }),
      },
    },
  });
  assert(v4.ok);

  assertEquals(
    await third,
    [
      {
        [alice]: {
          the: "application/json",
          of: doc2,
          is: { v: 4 },
          cause: refer({
            the: "application/json",
            of: doc2,
            is: { v: 1 },
            cause: { the: "application/json", of: doc2 },
          }),
        },
      },
    ],
    "did not got update for the document was unwatched",
  );
});

test("close subscription", memory, async session => {
  const subscription = session.subscribe({
    [alice]: {
      the: "application/json",
      of: doc,
    },
  });

  const inbox = take(subscription.stream, 2);

  await new Promise(resolve => setTimeout(resolve, 100));

  subscription.close();

  assertEquals(
    await inbox,
    [
      {
        [alice]: {
          the: "application/json",
          of: doc,
        },
      },
    ],
    "receives unclaimed fact",
  );
});

const take = async <T>(
  source: ReadableStream<T>,
  limit: number = Infinity,
): Promise<T[]> => {
  const results = [];
  const reader = source.getReader();
  try {
    while (results.length < limit) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      results.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return results;
};
