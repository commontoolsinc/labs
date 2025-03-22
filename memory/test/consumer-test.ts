import { assert, assertEquals, assertExists, assertMatch } from "@std/assert";
import * as Fact from "../fact.ts";
import * as Transaction from "../transaction.ts";
import * as Changes from "../changes.ts";
import * as Commit from "../commit.ts";
import * as Provider from "../provider.ts";
import * as Consumer from "../consumer.ts";
import { refer } from "merkle-reference";
import { alice, bob, space as subject } from "./principal.ts";
import { UTCUnixTimestampInSeconds } from "../interface.ts";

class Clock {
  private timestamp: UTCUnixTimestampInSeconds;
  constructor() {
    this.timestamp = (Date.now() / 1000) | 0;
  }
  now(): UTCUnixTimestampInSeconds {
    return this.timestamp;
  }
}

const doc = `of:${refer({ hello: "world" })}` as const;
const the = "application/json";

const test = (
  title: string,
  url: URL,
  run: (
    session: Provider.ProviderSession<Provider.Protocol>,
    provider: Provider.Provider<Provider.Protocol>,
  ) => Promise<unknown>,
) => {
  const unit = async () => {
    const open = await Provider.open({
      store: url,
    });

    assert(open.ok, "Open create repository if it does not exist");
    const provider = open.ok;
    const session = provider.session();

    try {
      await run(session, provider);
    } finally {
      await provider.close();
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

const store = new URL(`memory://`);

test("query empty memory", store, async (session) => {
  const clock = new Clock();
  const memory = Consumer.open({ as: subject, session, clock })
    .mount(subject.did());
  const query = memory.query({
    select: {},
  });

  const result = await query;

  assertEquals(result.ok?.selection, {
    [subject.did()]: {},
  });

  assertEquals(query.selection, { [subject.did()]: {} });
});

test("create new memory", store, async (session, provider) => {
  const clock = new Clock();
  const consumer = Consumer.open({ as: subject, session, clock });
  const memory = consumer.mount(subject.did());

  const v1 = Fact.assert({
    the: "application/json",
    of: doc,
    is: { v: 1 },
  });

  const result = await memory.transact({ changes: Changes.from([v1]) });

  assert(result.ok);
  const c1 = Commit.create({
    space: subject.did(),
    transaction: Transaction.create({
      issuer: subject.did(),
      subject: subject.did(),
      changes: Changes.from([v1]),
      clock,
    }),
  });

  assertEquals(result, { ok: Changes.from([c1]) });

  const { ok: query } = await memory.query({
    select: { [doc]: { [the]: {} } },
  });

  assertEquals(
    query?.selection,
    {
      [subject.did()]: Changes.from([v1]),
    },
    "fact was added to the memory",
  );

  {
    const consumer = Consumer.open({
      as: bob,
      session: provider.session(),
      clock,
    });

    const { ok: other } = await consumer.mount(bob.did()).query({
      select: { [doc]: { [the]: {} } },
    });
    assertEquals(
      other?.selection,
      {
        [bob.did()]: { [doc]: { [the]: {} } },
      },
      "fact is unclaimed in another memory space",
    );
  }
});

test("create memory fails if already exists", store, async (session) => {
  const clock = new Clock();
  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
  const memory = Consumer.open({ as: subject, session, clock })
    .mount(subject.did());

  const create = await memory.transact({
    changes: Changes.from([v1]),
  });

  assert(create.ok, "Document created");

  const v2 = Fact.assert({ the, of: doc, is: { fork: true } });

  const conflict = await memory.transact({
    changes: Changes.from([v2]),
  });

  assert(conflict.error, "Create fail when already exists");
  assert(conflict.error.name === "ConflictError");
  assertEquals(conflict.error.conflict, {
    space: subject.did(),
    the,
    of: doc,
    expected: null,
    actual: v1,
  });
});

test("list empty memory", store, async (session) => {
  const clock = new Clock();
  const memory = Consumer.open({ as: subject, session, clock })
    .mount(subject.did());
  const result = await memory.query({
    select: { _: { [the]: {} } },
  });

  assertEquals(result.ok?.selection, { [subject.did()]: {} }, "no facts exist");
});

test("list single fact", store, async (session) => {
  const clock = new Clock();
  const memory = Consumer.open({ as: subject, session, clock })
    .mount(subject.did());
  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
  // First create a fact
  await memory.transact({
    changes: Changes.from([v1]),
  });

  const result = await memory.query({ select: { _: { [the]: {} } } });

  assertEquals(
    result.ok?.selection,
    { [subject.did()]: Changes.from([v1]) },
    "lists single fact",
  );
});

test("list multiple facts", store, async (session) => {
  const clock = new Clock();
  const memory = Consumer.open({ as: subject, session, clock })
    .mount(subject.did());
  const doc2 = `of:${refer({ doc: 2 })}` as const;

  const facts = [
    Fact.assert({ the, of: doc, is: { v: 1 } }),
    Fact.assert({ the, of: doc2, is: { v: 2 } }),
  ];

  // Create multiple facts
  await memory.transact({
    changes: Changes.from(facts),
  });

  const result = await memory.query({
    select: { _: { [the]: {} } },
  });

  assertEquals(
    result.ok?.selection,
    { [subject.did()]: Changes.from(facts) },
    "lists multiple facts",
  );
});

test("list excludes retracted facts", store, async (session) => {
  const clock = new Clock();
  const memory = Consumer.open({ as: subject, session, clock })
    .mount(subject.did());
  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
  // First create and then retract a fact
  await memory.transact({ changes: Changes.from([v1]) });

  const q1 = await memory.query({
    select: { [doc]: { [the]: {} } },
  });
  assertEquals(q1.ok?.selection, { [subject.did()]: Changes.from([v1]) });

  const v2 = Fact.retract(v1);

  await memory.transact({
    changes: Changes.from([v2]),
  });

  const q2 = await memory.query({
    select: { [doc]: { [the]: { is: {} } } },
  });

  assertEquals(
    q2.ok?.selection,
    { [subject.did()]: { [doc]: { [the]: {} } } },
    "excludes retracted facts",
  );
});

test("list different fact types", store, async (session) => {
  const clock = new Clock();
  const memory = Consumer.open({ as: subject, session, clock })
    .mount(subject.did());
  const json = Fact.assert({ the, of: doc, is: { v: 1 } });
  const text = Fact.assert({ the: "text/plain", of: doc, is: "Hello" });

  // Create facts of different types
  await memory.transact({ changes: Changes.from([json, text]) });

  const jsonResult = await memory.query({
    select: { _: { [the]: {} } },
  });

  const textResult = await memory.query({
    select: { _: { ["text/plain"]: {} } },
  });

  assertEquals(
    jsonResult.ok?.selection,
    { [subject.did()]: Changes.from([json]) },
    "lists json facts",
  );

  assertEquals(
    textResult.ok?.selection,
    {
      [subject.did()]: Changes.from([text]),
    },
    "lists text facts",
  );
});

test("list multiple facts using graph query", store, async (session) => {
  const clock = new Clock();
  const memory = Consumer.open({ as: subject, session, clock })
    .mount(subject.did());
  const doc2 = `of:${refer({ doc: 2 })}` as const;

  const facts = [
    Fact.assert({ the, of: doc, is: { v: 1 } }),
    Fact.assert({ the, of: doc2, is: { v: 2 } }),
  ];

  // Create multiple facts
  await memory.transact({
    changes: Changes.from(facts),
  });

  // queryGraph returns the facts with an is portion for each schema, so they're arrays
  const wrappedFacts = facts.map((fact) =>
    Fact.assert({ the: fact.the, of: fact.of, is: [fact.is] })
  );

  const result = await memory.queryGraph({
    selectGraph: {
      _: { [the]: { _: [{ schema: true, rootSchema: true }] } },
    },
  });
  // assertExists(graphResult1.ok);
  // const selection = graphResult1.ok;
  // const result = { ok: graphResult1.ok, { [subject.did()]: selection.of }};
  assertEquals(
    result.ok?.selection,
    { [subject.did()]: Changes.from(wrappedFacts) },
    "lists multiple facts",
  );
});

test(
  "list facts from different memory spaces",
  store,
  async (session, provider) => {
    const clock = new Clock();
    const aliceConsumer = Consumer.open({ as: alice, session, clock });
    const aliceSpace = aliceConsumer.mount(alice.did());
    const bobConsumer = Consumer.open({
      as: bob,
      session: provider.session(),
      clock,
    });
    const bobSpace = bobConsumer.mount(bob.did());

    const a = Fact.assert({ the, of: doc, is: { v: 1 } });
    const b = Fact.assert({ the, of: doc, is: { v: 2 } });

    // Create facts in different replica spaces
    await aliceSpace.transact({
      changes: Changes.from([a]),
    });

    await bobSpace.transact({
      changes: Changes.from([b]),
    });

    const aliceResult = await aliceSpace.query({ select: { [doc]: {} } });

    const bobResult = await bobSpace.query({ select: { [doc]: {} } });

    assertEquals(
      aliceResult.ok?.selection,
      { [alice.did()]: Changes.from([a]) },
      "lists alice's facts",
    );

    assertEquals(
      bobResult.ok?.selection,
      { [bob.did()]: Changes.from([b]) },
      "lists bob's facts",
    );
  },
);

test("subscribe receives unclaimed state", store, async (session) => {
  const clock = new Clock();
  const memory = Consumer.open({ as: subject, session, clock })
    .mount(subject.did());

  const { ok: query } = await memory.query({
    select: { [doc]: { [the]: {} } },
  });
  assert(query);

  assertEquals(
    query.selection,
    {
      [subject.did()]: {
        [doc]: {
          [the]: {},
        },
      },
    },
    "noting yet",
  );

  query.subscribe();

  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
  const c1 = await memory.transact({ changes: Changes.from([v1]) });
  assert(c1.ok);

  assertEquals(query.selection, { [subject.did()]: Changes.from([v1]) });
  assertEquals(query.facts, [v1], "changes were reflected");
});

test("subscribe receives unclaimed state", store, async (session) => {
  const clock = new Clock();
  const memory = Consumer.open({ as: subject, session, clock })
    .mount(subject.did());

  const { ok: query } = await memory.query({
    select: { [doc]: { [the]: {} } },
  });
  assert(query);
  assertEquals(
    query.selection,
    {
      [subject.did()]: {
        [doc]: {
          [the]: {},
        },
      },
    },
    "noting yet",
  );
  query.subscribe();

  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
  const c1 = await memory.transact({ changes: Changes.from([v1]) });
  assert(c1.ok);

  assertEquals(query.selection, { [subject.did()]: Changes.from([v1]) });
  assertEquals(query.facts, [v1], "changes were reflected");
});

test("subscription receives retraction", store, async (session) => {
  const clock = new Clock();
  const memory = Consumer.open({ as: subject, session, clock })
    .mount(subject.did());
  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });

  await memory.transact({ changes: Changes.from([v1]) });

  const selector = { [doc]: { [the]: {} } };

  const { ok: query } = await memory.query({ select: selector });
  assert(query);
  query.subscribe();

  assertEquals(query.facts, [v1]);
  const v2 = Fact.retract(v1);

  const retract = await memory.transact({ changes: Changes.from([v2]) });

  assert(retract.ok, "retracted");

  assertEquals(query.facts, [v2]);
});

test("cancel subscription", store, async (session) => {
  const clock = new Clock();
  const memory = Consumer.open({ as: subject, session, clock })
    .mount(subject.did());
  const doc2 = `of:${refer({ doc: 2 })}` as const;

  const selector = { [doc]: { [the]: {} } };
  const { ok: query } = await memory.query({ select: selector });
  assert(query);
  const subscription = query.subscribe();

  const v2 = Fact.assert({ the, of: doc2, is: { doc: 2 } });

  const t1 = Transaction.create({
    issuer: subject.did(),
    subject: subject.did(),
    changes: Changes.from([v2]),
    clock,
  });

  const r1 = await memory.transact({ changes: Changes.from([v2]) });

  assert(r1.ok, "asserted second doc");

  assertEquals(
    query.selection,
    {
      [subject.did()]: {
        [doc]: { [the]: {} },
      },
    },
    "update to unrelated document is not send to subscription",
  );

  const v1 = Fact.assert({ the, of: doc, is: { doc: 1 } });

  const r2 = await memory.transact({ changes: Changes.from([v1]) });
  assert(r2.ok);

  assertEquals(query.facts, [v1], "received transaction on subscription");

  const selector2 = { [doc2]: { [the]: {} } };
  const { ok: query2 } = await memory.query({ select: selector2 });
  assert(query2, "subscription established");
  query2.subscribe();

  assertEquals(query2.facts, [v2], "has facts from first transaction");
  await subscription.cancel();

  const v3 = Fact.assert({ the, of: doc, is: { doc: 1, t: 3 }, cause: v1 });

  const r3 = await memory.transact({ changes: Changes.from([v3]) });
  assert(r3.ok);

  assertEquals(
    query.facts,
    [v1],
    "cancelled subscription does not receives a transaction",
  );

  const v4 = Fact.assert({ the, of: doc2, is: { doc: 2, t: 4 }, cause: v2 });

  const r4 = await memory.transact({ changes: Changes.from([v4]) });
  assert(r4.ok);

  assertEquals(query2.facts, [v4]);
});

test("several subscriptions receive single update", store, async (session) => {
  const clock = new Clock();
  const memory = Consumer.open({ as: subject, session, clock })
    .mount(subject.did());
  const doc1 = `of:${refer({ doc: 1 })}` as const;
  const doc2 = `of:${refer({ doc: 2 })}` as const;

  const { ok: query1 } = await memory.query({
    select: {
      [doc1.toString()]: {},
    },
  });
  const { ok: query2 } = await memory.query({
    select: {
      [doc2.toString()]: {},
    },
  });

  query1?.subscribe();
  query2?.subscribe();

  const fact1 = Fact.assert({ the, of: doc1, is: { doc: 1 } });
  const fact2 = Fact.assert({ the, of: doc2, is: { doc: 2 } });
  const tr = await memory.transact({
    changes: Changes.from([fact1, fact2]),
  });

  assert(tr.ok);

  assertEquals(query1?.selection, {
    [subject.did()]: Changes.from([fact1]),
  });

  assertEquals(query2?.selection, {
    [subject.did()]: Changes.from([fact2]),
  });
});

test("can not query unauthorized space", store, async (session) => {
  const clock = new Clock();
  const memory = Consumer.open({ as: alice, session, clock })
    .mount(subject.did());

  const query = await memory.query({
    select: {},
  });

  assertMatch(
    query.error?.message ?? "",
    new RegExp(
      `Principal ${alice.did()} has no authority over ${subject.did()} space`,
    ),
  );
});

test("can not transact unauthorized space", store, async (session) => {
  const clock = new Clock();
  const memory = Consumer.open({ as: alice, session, clock })
    .mount(subject.did());

  const v1 = Fact.assert({
    the: "application/json",
    of: doc,
    is: { v: 1 },
  });

  const result = await memory.transact({
    changes: Changes.from([v1]),
  });

  assertMatch(
    result.error?.message ?? "",
    new RegExp(
      `Principal ${alice.did()} has no authority over ${subject.did()} space`,
    ),
  );
});
