import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import * as Memory from "../memory.ts";
import { refer, Space, Subscriber, Subscription } from "../provider.ts";

const alice = "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi";
const space = "did:key:z6MkffDZCkCTWreg8868fG1FGFogcJj5X6PY93pPcWDn9bob";
// const doc = refer({ hello: "world" }).toString();
// const doc2 = refer({ hi: "world" }).toString();
const doc = "doc-1";
const doc2 = "doc-2";
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

test("subscribe receives unclaimed state", memory, async (session) => {
  const subscriber = Subscriber.create();
  await session.subscribe(subscriber);

  subscriber.watch({
    cmd: "/memory/query",
    iss: alice,
    sub: space,
    args: {
      selector: {
        the,
        of: doc,
      },
    },
  });

  const [none] = await take(subscriber.commands, 1);

  assertEquals(
    none,
    {
      brief: {
        sub: space,
        args: {
          selector: { the, of: doc },
          selection: [],
        },
      },
    },
    "no facts found",
  );
});

test("subscribe receives unclaimed then asserted", memory, async (session) => {
  const subscriber = Subscriber.create();
  await session.subscribe(subscriber);

  const selector = { the, of: doc };

  subscriber.watch({
    cmd: "/memory/query",
    iss: alice,
    sub: space,
    args: { selector },
  });

  const transaction = {
    cmd: "/memory/transact",
    iss: alice,
    sub: space,
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
  } as const;

  session.transact(transaction);

  const updates = await take(subscriber.commands, 2);

  assertEquals(updates, [
    {
      brief: {
        sub: space,
        args: {
          selector,
          selection: [],
        },
      },
    },
    {
      transact: transaction,
    },
  ]);
});

test("subscribe receives retraction", memory, async (session) => {
  const transaction = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [Space.init({ the, of: doc }).toString()]: {
            is: { v: 1 },
          },
        },
      },
    },
  });

  await session.transact(transaction);

  const selector = { the, of: doc };

  const subscriber = Subscriber.create();
  await session.subscribe(subscriber);
  await subscriber.watch({
    cmd: "/memory/query",
    iss: alice,
    sub: space,
    args: { selector },
  });

  const retraction = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [refer({ is: { v: 1 }, cause: Space.init({ the, of: doc }) }).toString()]: null,
        },
      },
    },
  });

  const retract = await session.transact(retraction);

  assert(retract.ok, "retracted");

  const updates = await take(subscriber.commands, 2);
  assertEquals(updates, [
    {
      brief: {
        sub: space,
        args: {
          selector,
          selection: [
            {
              the,
              of: doc,
              is: { v: 1 },
              cause: Space.init({ the, of: doc }),
            },
          ],
        },
      },
    },
    {
      transact: retraction,
    },
  ]);
});

test("subscription watch / unwatch", memory, async (session) => {
  const subscriber = Subscriber.create();
  session.subscribe(subscriber);

  const selector = { the, of: doc };

  subscriber.watch({
    cmd: "/memory/query",
    iss: alice,
    sub: space,
    args: {
      selector,
    },
  });

  const two = take(subscriber.commands, 2);
  const t1 = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc2]: {
          [Space.init({ the, of: doc2 }).toString()]: {
            is: { doc: 2 },
          },
        },
      },
    },
  });

  const v1 = await session.transact(t1);

  assert(v1.ok, "asserted second doc");

  const t2 = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [Space.init({ the, of: doc }).toString()]: {
            is: { doc: 1 },
          },
        },
      },
    },
  });
  await session.transact(t2);

  assertEquals(
    await two,
    [
      {
        brief: {
          sub: space,
          args: {
            selector,
            selection: [],
          },
        },
      },
      {
        transact: t2,
      },
    ],
    "did not got update for the document was not subscribed to",
  );

  const next = take(subscriber.commands, 1);
  const selector2 = { the, of: doc2 };
  await subscriber.watch({
    cmd: "/memory/query",
    iss: alice,
    sub: space,
    args: {
      selector: selector2,
    },
  });

  assertEquals(
    await next,
    [
      {
        brief: {
          sub: space,
          args: {
            selector: selector2,
            selection: [
              {
                the,
                of: doc2,
                is: { doc: 2 },
                cause: Space.init(selector2),
              },
            ],
          },
        },
      },
    ],
    "got update for the document was subscribed to",
  );

  subscriber.unwatch({
    cmd: "/memory/query",
    iss: alice,
    sub: space,
    args: {
      selector,
    },
  });

  const third = take(subscriber.commands, 1);

  const t3 = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc]: {
          [refer({ is: { doc: 1 }, cause: Space.init({ the, of: doc }) }).toString()]: {
            is: { doc: 1, t: 3 },
          },
        },
      },
    },
  });

  const v3 = await session.transact(t3);
  assert(v3.ok);

  const t4 = Space.transaction({
    issuer: alice,
    subject: space,
    changes: {
      [the]: {
        [doc2]: {
          [refer({ is: { doc: 2 }, cause: Space.init({ the, of: doc2 }) }).toString()]: {
            is: {
              doc: 2,
              t: 4,
            },
          },
        },
      },
    },
  });

  const v4 = await session.transact(t4);
  assert(v4.ok);

  assertEquals(
    await third,
    [
      {
        transact: t4,
      },
    ],
    "did not got update for the document was unwatched",
  );
});

test("close subscription", memory, async (session) => {
  const subscriber = Subscriber.create();
  session.subscribe(subscriber);

  const selector = { the, of: doc };
  subscriber.watch({
    cmd: "/memory/query",
    iss: alice,
    sub: space,
    args: {
      selector,
    },
  });

  const inbox = take(subscriber.commands, 2);

  await new Promise((resolve) => setTimeout(resolve, 100));

  subscriber.close();

  assertEquals(
    await inbox,
    [
      {
        brief: {
          sub: space,
          args: {
            selector,
            selection: [],
          },
        },
      },
    ],
    "receives brief only",
  );
});

const take = async <T>(source: ReadableStream<T>, limit: number = Infinity): Promise<T[]> => {
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
