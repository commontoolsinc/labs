import { assert, assertEquals } from "@std/assert";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
} from "@std/testing/bdd";
import * as Memory from "../memory.ts";
import * as Fact from "../fact.ts";
import * as Transaction from "../transaction.ts";
import * as Changes from "../changes.ts";
import * as Selection from "../selection.ts";
import * as Commit from "../commit.ts";
import * as Query from "../query.ts";
import {
  hashOf,
  resetModernHashConfig,
  setModernHashConfig,
} from "@commonfabric/data-model/value-hash";

const alice = "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi";
const bob = "did:key:z6MkffDZCkCTWreg8868fG1FGFogcJj5X6PY93pPcWDn9bob";
const space = bob;
const the = "application/json";

// Some generated service key.
const serviceDid = "did:key:z6MkfJPMCrTyDmurrAHPUsEjCgvcjvLtAuzyZ7nSqwZwb8KQ";

const memory = new URL(`memory://`);

for (const modernHash of [false, true]) {
  describe(`modernHash=${modernHash}`, () => {
    let doc: `of:${string}`;
    let session: Memory.MemorySession;

    beforeAll(() => {
      setModernHashConfig(modernHash);
      doc = `of:${hashOf({ hello: "world" })}` as const;
      resetModernHashConfig();
    });

    beforeEach(async () => {
      setModernHashConfig(modernHash);
      const open = await Memory.open({
        store: memory,
        serviceDid,
      });
      assert(open.ok, "Open create repository if it does not exist");
      session = open.ok;
    });

    afterEach(async () => {
      await session.close();
      resetModernHashConfig();
    });

    it("query non-existing", async () => {
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

    it("create new memory", async () => {
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
          ok: { [space]: Selection.from([[v1, c1.is.since]]) },
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

    it("create memory fails if already exists", async () => {
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
      const { history: _, ...baseConflict } = conflict.error.conflict;
      assertEquals(baseConflict, {
        space,
        the,
        of: doc,
        expected: null,
        existsInHistory: false,
        actual: { ...v1, since: 0 },
      });
    });

    // List tests

    it("list empty memory", async () => {
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

    it("list single fact", async () => {
      const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
      // First create a fact
      const tr1 = await session.transact(
        Transaction.create({
          issuer: alice,
          subject: space,
          changes: Changes.from([v1]),
        }),
      );
      assert(tr1.ok);
      const c1 = Commit.toRevision(tr1.ok);

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
          ok: { [space]: Selection.from([[v1, c1.is.since]]) },
        },
        "lists single fact",
      );
    });

    it("list multiple facts", async () => {
      const doc2 = `of:${hashOf({ doc: 2 })}` as const;

      const facts = [
        Fact.assert({ the, of: doc, is: { v: 1 } }),
        Fact.assert({ the, of: doc2, is: { v: 2 } }),
      ];

      // Create multiple facts
      const tr1 = await session.transact(
        Transaction.create({
          issuer: alice,
          subject: space,
          changes: Changes.from(facts),
        }),
      );
      assert(tr1.ok);
      const c1 = Commit.toRevision(tr1.ok);

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
          ok: {
            [space]: Selection.from(facts.map((fact) => [fact, c1.is.since])),
          },
        },
        "lists multiple facts",
      );
    });

    it("list excludes retracted facts", async () => {
      const v1 = Fact.assert({ the, of: doc, is: { v: 1 } });
      // First create and then retract a fact
      const tr1 = await session.transact(
        Transaction.create({
          issuer: alice,
          subject: space,
          changes: Changes.from([v1]),
        }),
      );
      assert(tr1.ok);
      const c1 = Commit.toRevision(tr1.ok);

      assertEquals(
        await session.query(
          Query.create({
            issuer: alice,
            subject: space,
            select: { [doc]: { [the]: {} } },
          }),
        ),
        {
          ok: { [space]: Selection.from([[v1, c1.is.since]]) },
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
                "_": {
                  is: {},
                },
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

    it("list different fact types", async () => {
      const json = Fact.assert({ the, of: doc, is: { v: 1 } });
      const text = Fact.assert({ the: "text/plain", of: doc, is: "Hello" });

      const tr = Transaction.create({
        issuer: alice,
        subject: space,
        changes: Changes.from([json, text]),
      });

      // Create facts of different types
      const result = await session.transact(tr);
      assert(result.ok);
      const c1 = Commit.toRevision(result.ok);

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
          ok: { [space]: Selection.from([[json, c1.is.since]]) },
        },
        "lists json facts",
      );

      assertEquals(
        textResult,
        {
          ok: {
            [space]: Selection.from([[text, c1.is.since]]),
          },
        },
        "lists text facts",
      );
    });

    it("list facts from different replicas", async () => {
      const a = Fact.assert({ the, of: doc, is: { v: 1 } });
      const b = Fact.assert({ the, of: doc, is: { v: 2 } });

      // Create facts in different replica spaces
      const tr1 = await session.transact(
        Transaction.create({
          issuer: alice,
          subject: alice,
          changes: Changes.from([a]),
        }),
      );
      assert(tr1.ok);
      const c1 = Commit.toRevision(tr1.ok);

      const tr2 = await session.transact(
        Transaction.create({
          issuer: alice,
          subject: bob,
          changes: Changes.from([b]),
        }),
      );
      assert(tr2.ok);
      const c2 = Commit.toRevision(tr2.ok);

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
          ok: { [alice]: Selection.from([[a, c1.is.since]]) },
        },
        "lists alice's facts",
      );

      assertEquals(
        bobResult,
        {
          ok: { [bob]: Selection.from([[b, c2.is.since]]) },
        },
        "lists bob's facts",
      );
    });

    it("list from non-existent replica", async () => {
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
      assertEquals(
        result,
        { ok: { [space]: {} } },
        "empty list from new replica",
      );
    });
  });
}
