import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import * as Memory from "../memory.ts";
import { refer, Space, Subscriber, Subscription } from "../provider.ts";
import * as Fact from "../fact.ts";
import * as Changes from "../changes.ts";
import * as Transaction from "../transaction.ts";
import * as Query from "../query.ts";

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

  subscriber.watch(
    Query.create({
      issuer: alice,
      subject: space,
      select: { [doc]: { [the]: {} } },
    }),
  );

  const [none] = await take(subscriber.commands, 1);

  assertEquals(
    none,
    {
      brief: {
        sub: space,
        args: {
          selector: {
            [doc]: {
              [the]: {},
            },
          },
          selection: {
            [space]: {
              [doc]: {
                [the]: {},
              },
            },
          },
        },
      },
    },
    "no facts found",
  );
});

test("subscribe receives unclaimed then asserted", memory, async (session) => {
  const subscriber = Subscriber.create();
  await session.subscribe(subscriber);

  const selector = { [doc]: { [the]: {} } };

  subscriber.watch(
    Query.create({
      issuer: alice,
      subject: space,
      select: selector,
    }),
  );

  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });

  const transaction = Transaction.create({
    issuer: alice,
    subject: space,
    changes: Changes.from([v1]),
  });

  session.transact(transaction);

  const updates = await take(subscriber.commands, 2);

  assertEquals(updates, [
    {
      brief: {
        sub: space,
        args: {
          selector,
          selection: {
            [space]: {
              [doc]: {
                [the]: {},
              },
            },
          },
        },
      },
    },
    {
      transact: transaction,
    },
  ]);
});

test("subscribe receives retraction", memory, async (session) => {
  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
  const transaction = Transaction.create({
    issuer: alice,
    subject: space,
    changes: Changes.from([v1]),
  });

  await session.transact(transaction);

  const selector = { [doc]: { [the]: {} } };

  const subscriber = Subscriber.create();
  await session.subscribe(subscriber);
  await subscriber.watch(
    Query.create({
      issuer: alice,
      subject: space,
      select: selector,
    }),
  );
  const v2 = Fact.retract(v1);

  const retraction = Transaction.create({
    issuer: alice,
    subject: space,
    changes: Changes.from([v2]),
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
          selection: { [space]: Changes.from([v1]) },
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

  const selector = { [doc]: { [the]: {} } };

  subscriber.watch(
    Query.create({
      issuer: alice,
      subject: space,
      select: selector,
    }),
  );

  const two = take(subscriber.commands, 2);
  const v2 = Fact.assert({ the, of: doc2, is: { doc: 2 } });

  const t1 = Transaction.create({
    issuer: alice,
    subject: space,
    changes: Changes.from([v2]),
  });

  const r1 = await session.transact(t1);

  assert(r1.ok, "asserted second doc");

  const v1 = Fact.assert({ the, of: doc, is: { doc: 1 } });

  const t2 = Transaction.create({
    issuer: alice,
    subject: space,
    changes: Changes.from([v1]),
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
            selection: { [space]: { [doc]: { [the]: {} } } },
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
  const selector2 = { [doc2]: { [the]: {} } };
  await subscriber.watch(
    Query.create({
      issuer: alice,
      subject: space,
      select: selector2,
    }),
  );

  assertEquals(
    await next,
    [
      {
        brief: {
          sub: space,
          args: {
            selector: selector2,
            selection: { [space]: Changes.from([v2]) },
          },
        },
      },
    ],
    "got update for the document was subscribed to",
  );

  subscriber.unwatch(
    Query.create({
      issuer: alice,
      subject: space,
      select: selector,
    }),
  );

  const third = take(subscriber.commands, 1);

  const v3 = Fact.assert({ the, of: doc, is: { doc: 1, t: 3 }, cause: v1 });

  const t3 = Transaction.create({
    issuer: alice,
    subject: space,
    changes: Changes.from([v3]),
  });

  const r3 = await session.transact(t3);
  assert(r3.ok);

  const v4 = Fact.assert({ the, of: doc2, is: { doc: 2, t: 4 }, cause: v2 });

  const t4 = Transaction.create({
    issuer: alice,
    subject: space,
    changes: Changes.from([v4]),
  });

  const r4 = await session.transact(t4);
  assert(r4.ok);

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

  const selector = { [doc]: { [the]: {} } };
  subscriber.watch(
    Query.create({
      issuer: alice,
      subject: space,
      select: selector,
    }),
  );

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
            selection: { [space]: { [doc]: { [the]: {} } } },
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
