import { assert, assertEquals, assertExists, assertMatch } from "https://deno.land/std/assert/mod.ts";
import * as Fact from "../fact.ts";
import * as Transaction from "../transaction.ts";
import * as Changes from "../changes.ts";
import * as Commit from "../commit.ts";
import * as Provider from "../provider.ts";
import * as Consumer from "../consumer.ts";
import * as Selection from "../selection.ts";
import { refer } from "npm:merkle-reference";
import { alice, bob, space as subject } from "./principal.ts";
import { UTCUnixTimestampInSeconds } from "../interface.ts";

// Some generated service key.
const serviceDid = "did:key:z6MkfJPMCrTyDmurrAHPUsEjCgvcjvLtAuzyZ7nSqwZwb8KQ";

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
      serviceDid,
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
      [subject.did()]: Selection.from([[v1, c1.is.since]]),
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
  const tr1 = await memory.transact({
    changes: Changes.from([v1]),
  });
  assert(tr1.ok);
  const c1 = Commit.toRevision(tr1.ok);

  const result = await memory.query({ select: { _: { [the]: {} } } });

  assertEquals(
    result.ok?.selection,
    { [subject.did()]: Selection.from([[v1, c1.is.since]]) },
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
  const tr1 = await memory.transact({
    changes: Changes.from(facts),
  });
  assert(tr1.ok);

  const c1 = Commit.toRevision(tr1.ok);

  const result = await memory.query({
    select: { _: { [the]: {} } },
  });

  assertEquals(
    result.ok?.selection,
    {
      [subject.did()]: Selection.from(facts.map((fact) => [fact, c1.is.since])),
    },
    "lists multiple facts",
  );
});

test("list excludes retracted facts", store, async (session) => {
  const clock = new Clock();
  const memory = Consumer.open({ as: subject, session, clock })
    .mount(subject.did());
  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
  // First create and then retract a fact
  const tr1 = await memory.transact({ changes: Changes.from([v1]) });

  assert(tr1.ok);
  const c1 = Commit.toRevision(tr1.ok);

  const q1 = await memory.query({
    select: { [doc]: { [the]: {} } },
  });
  assertEquals(q1.ok?.selection, {
    [subject.did()]: Selection.from([[v1, c1.is.since]]),
  });

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
  const { ok } = await memory.transact({ changes: Changes.from([json, text]) });

  assert(ok);
  const c1 = Commit.toRevision(ok);

  const jsonResult = await memory.query({
    select: { _: { [the]: {} } },
  });

  const textResult = await memory.query({
    select: { _: { ["text/plain"]: {} } },
  });

  assertEquals(
    jsonResult.ok?.selection,
    { [subject.did()]: Selection.from([[json, c1.is.since]]) },
    "lists json facts",
  );

  assertEquals(
    textResult.ok?.selection,
    {
      [subject.did()]: Selection.from([[text, c1.is.since]]),
    },
    "lists text facts",
  );
});

test("list multiple facts using schema query", store, async (session) => {
  const clock = new Clock();
  const memory = Consumer.open({ as: subject, session, clock })
    .mount(subject.did());
  const doc2 = `of:${refer({ doc: 2 })}` as const;

  const facts = [
    Fact.assert({ the, of: doc, is: { value: { v: 1 } } }),
    Fact.assert({ the, of: doc2, is: { value: { v: 2 } } }),
  ];

  // Create multiple facts
  const tr = await memory.transact({
    changes: Changes.from(facts),
  });
  assert(tr.ok);
  const commit = Commit.toRevision(tr.ok);

  const result = await memory.query({
    selectSchema: {
      _: {
        [the]: {
          _: { path: [], schemaContext: { schema: true, rootSchema: true } },
        },
      },
    },
  });

  const expectedFacts: Record<string, any> = {};
  for (const fact of facts) {
    expectedFacts[fact.cause.toString()] = { is: fact.is, since: commit.since };
  }
  const factChanges = Selection.from(facts.map((fact) => [fact, commit.since]));
  assertEquals(
    result.ok?.selection,
    { [subject.did()]: factChanges },
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
    const tr1 = await aliceSpace.transact({
      changes: Changes.from([a]),
    });

    const c1 = Commit.toRevision(tr1.ok!);

    const tr2 = await bobSpace.transact({
      changes: Changes.from([b]),
    });
    const c2 = Commit.toRevision(tr2.ok!);

    const aliceResult = await aliceSpace.query({ select: { [doc]: {} } });

    const bobResult = await bobSpace.query({ select: { [doc]: {} } });

    assertEquals(
      aliceResult.ok?.selection,
      { [alice.did()]: Selection.from([[a, c1.is.since]]) },
      "lists alice's facts",
    );

    assertEquals(
      bobResult.ok?.selection,
      { [bob.did()]: Selection.from([[b, c2.is.since]]) },
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
  const tr1 = await memory.transact({ changes: Changes.from([v1]) });
  assert(tr1.ok);
  const c1 = Commit.toRevision(tr1.ok);

  assertEquals(query.selection, {
    [subject.did()]: Selection.from([[v1, c1.is.since]]),
  });
  assertEquals(
    query.facts,
    [{ ...v1, since: c1.is.since }],
    "changes were reflected",
  );
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
  const tr1 = await memory.transact({ changes: Changes.from([v1]) });
  assert(tr1.ok);
  const c1 = Commit.toRevision(tr1.ok);

  assertEquals(query.selection, {
    [subject.did()]: Selection.from([[v1, c1.is.since]]),
  });
  assertEquals(
    query.facts,
    [{ ...v1, since: c1.is.since }],
    "changes were reflected",
  );
});

test("subscription receives retraction", store, async (session) => {
  const clock = new Clock();
  const memory = Consumer.open({ as: subject, session, clock })
    .mount(subject.did());
  const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });

  const tr1 = await memory.transact({ changes: Changes.from([v1]) });
  assert(tr1.ok);
  const c1 = Commit.toRevision(tr1.ok);

  const selector = { [doc]: { [the]: {} } };

  const { ok: query } = await memory.query({ select: selector });
  assert(query);
  query.subscribe();

  assertEquals(query.facts, [{ ...v1, since: c1.is.since }]);
  const v2 = Fact.retract(v1);

  const retract = await memory.transact({ changes: Changes.from([v2]) });
  assert(retract.ok);
  const c2 = Commit.toRevision(retract.ok);

  assert(retract.ok, "retracted");

  assertEquals(query.facts, [{ ...v2, since: c2.is.since }]);
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
  assert(r1.ok);
  const c1 = Commit.toRevision(r1.ok);

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
  const c2 = Commit.toRevision(r2.ok);

  assertEquals(
    query.facts,
    [{ ...v1, since: c2.is.since }],
    "received transaction on subscription",
  );

  const selector2 = { [doc2]: { [the]: {} } };
  const { ok: query2 } = await memory.query({ select: selector2 });
  assert(query2, "subscription established");
  query2.subscribe();

  assertEquals(
    query2.facts,
    [{ ...v2, since: c1.is.since }],
    "has facts from first transaction",
  );
  await subscription.close();

  const v3 = Fact.assert({ the, of: doc, is: { doc: 1, t: 3 }, cause: v1 });

  const r3 = await memory.transact({ changes: Changes.from([v3]) });
  assert(r3.ok);

  assertEquals(
    query.facts,
    [{ ...v1, since: c2.is.since }],
    "cancelled subscription does not receives a transaction",
  );

  const v4 = Fact.assert({ the, of: doc2, is: { doc: 2, t: 4 }, cause: v2 });

  const r4 = await memory.transact({ changes: Changes.from([v4]) });
  assert(r4.ok);
  const c4 = Commit.toRevision(r4.ok);

  assertEquals(query2.facts, [{ ...v4, since: c4.is.since }]);
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
  const c1 = Commit.toRevision(tr.ok);

  assertEquals(query1?.selection, {
    [subject.did()]: Selection.from([[fact1, c1.is.since]]),
  });

  assertEquals(query2?.selection, {
    [subject.did()]: Selection.from([[fact2, c1.is.since]]),
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

test("subscribe to commits", store, async (session) => {
  const clock = new Clock();
  const memory = Consumer.open({ as: alice, session, clock })
    .mount(alice.did());

  const v1 = Fact.assert({
    the: "application/json",
    of: doc,
    is: { v: 1 },
  });

  const r1 = await memory.transact({
    changes: Changes.from([v1]),
  });
  assert(r1.ok);

  const v2 = Fact.assert({
    the: "application/json",
    of: doc,
    is: { v: 2 },
    cause: v1,
  });

  const r2 = await memory.transact({
    changes: Changes.from([v2]),
  });

  assert(r2.ok);

  const query = memory.query({
    select: {
      [alice.did()]: {
        "application/commit+json": {
          _: {},
        },
      },
    },
  });

  const subscription = query.subscribe();
  const reader = subscription.getReader();
  const p1 = reader.read();

  const v3 = Fact.assert({
    the: "application/json",
    of: doc,
    is: { v: 3 },
    cause: v2,
  });

  const r3 = await memory.transact({
    changes: Changes.from([v3]),
  });
  assert(r3.ok);

  const c3 = Commit.toRevision(r3.ok);

  assertEquals(await p1, {
    done: false,
    value: {
      [alice.did()]: {
        [alice.did()]: {
          ["application/commit+json"]: {
            [c3.cause.toString()]: {
              is: c3.is,
              since: c3.is.since,
            },
          },
        },
      },
    },
  });

  reader.cancel();
});
