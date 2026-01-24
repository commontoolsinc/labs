/**
 * Benchmarks for memory fact operations: set, get, retract
 *
 * Run with: deno bench test/benchmark.ts
 */

import { Database } from "@db/sqlite";
import { refer } from "merkle-reference";
import type { JSONValue } from "../interface.ts";
import * as Space from "../space.ts";
import * as Fact from "../fact.ts";
import * as Transaction from "../transaction.ts";
import * as Changes from "../changes.ts";
import * as Query from "../query.ts";
import { alice, space } from "./principal.ts";

const the = "application/json";

// Helper to create unique document IDs
let docCounter = 0;
const createDoc = () => `of:${refer({ id: docCounter++ })}` as const;

// Helper to create realistic ~16KB payload (typical fact size)
function createTypicalPayload(): JSONValue {
  const basePayload = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {
      version: 1,
      type: "document",
      tags: ["benchmark", "test"],
    },
  };

  const baseSize = JSON.stringify(basePayload).length;
  const contentSize = Math.max(0, 16 * 1024 - baseSize - 50);

  return {
    ...basePayload,
    content: "X".repeat(contentSize),
  };
}

// Helper to open a fresh in-memory space
async function openSpace() {
  const result = await Space.open({
    url: new URL(`memory:${space.did()}`),
  });
  if (result.error) throw result.error;
  return result.ok;
}

// --------------------------------------------------------------------------
// Benchmark: Set a fact (assertion)
// --------------------------------------------------------------------------

// Helper to warm up a session with an initial transaction
function warmUp(session: Space.View) {
  const warmupDoc = createDoc();
  const warmupAssertion = Fact.assert({
    the,
    of: warmupDoc,
    is: { warmup: true },
  });
  const result = session.transact(
    Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([warmupAssertion]),
    }),
  );
  if (result.error) throw result.error;
}

Deno.bench({
  name: "set fact (single ~16KB assertion)",
  group: "set",
  baseline: true,
  async fn(b) {
    const session = await openSpace();
    warmUp(session);

    const doc = createDoc();
    const payload = createTypicalPayload();

    b.start();
    const assertion = Fact.assert({
      the,
      of: doc,
      is: payload,
    });

    const transaction = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([assertion]),
    });

    const result = session.transact(transaction);
    b.end();

    if (result.error) throw result.error;
    session.close();
  },
});

Deno.bench({
  name: "set fact (10 ~16KB assertions batch)",
  group: "set",
  async fn(b) {
    const session = await openSpace();
    warmUp(session);

    const docs = Array.from({ length: 10 }, () => createDoc());
    const payloads = Array.from({ length: 10 }, () => createTypicalPayload());

    b.start();
    const assertions = docs.map((doc, i) =>
      Fact.assert({
        the,
        of: doc,
        is: payloads[i],
      })
    );

    const transaction = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from(assertions),
    });

    const result = session.transact(transaction);
    b.end();

    if (result.error) throw result.error;
    session.close();
  },
});

Deno.bench({
  name: "set fact (100 ~16KB assertions batch)",
  group: "set",
  async fn(b) {
    const session = await openSpace();
    warmUp(session);

    const docs = Array.from({ length: 100 }, () => createDoc());
    const payloads = Array.from({ length: 100 }, () => createTypicalPayload());

    b.start();
    const assertions = docs.map((doc, i) =>
      Fact.assert({
        the,
        of: doc,
        is: payloads[i],
      })
    );

    const transaction = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from(assertions),
    });

    const result = session.transact(transaction);
    b.end();

    if (result.error) throw result.error;
    session.close();
  },
});

// --------------------------------------------------------------------------
// Benchmark: Get a fact (query)
// --------------------------------------------------------------------------

Deno.bench({
  name: "get fact (single ~16KB query)",
  group: "get",
  baseline: true,
  async fn(b) {
    const session = await openSpace();
    const doc = createDoc();

    // Setup: create the fact first
    const assertion = Fact.assert({ the, of: doc, is: createTypicalPayload() });
    const transaction = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([assertion]),
    });
    session.transact(transaction);

    b.start();
    const query = Query.create({
      issuer: alice.did(),
      subject: space.did(),
      select: { [doc]: { [the]: {} } },
    });
    const result = session.query(query);
    b.end();

    if (result.error) throw result.error;
    session.close();
  },
});

Deno.bench({
  name: "get fact (query 10 specific ~16KB docs)",
  group: "get",
  async fn(b) {
    const session = await openSpace();
    const docs = Array.from({ length: 10 }, () => createDoc());

    // Setup: create facts for all docs
    const assertions = docs.map((doc) =>
      Fact.assert({ the, of: doc, is: createTypicalPayload() })
    );
    const transaction = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from(assertions),
    });
    session.transact(transaction);

    b.start();
    // Query each doc individually
    const results = [];
    for (const doc of docs) {
      const query = Query.create({
        issuer: alice.did(),
        subject: space.did(),
        select: { [doc]: { [the]: {} } },
      });
      results.push(session.query(query));
    }
    b.end();

    for (const result of results) {
      if (result.error) throw result.error;
    }
    session.close();
  },
});

Deno.bench({
  name: "get fact (wildcard query 100 ~16KB docs)",
  group: "get",
  async fn(b) {
    const session = await openSpace();

    // Setup: create 100 facts
    const assertions = Array.from({ length: 100 }, () =>
      Fact.assert({
        the,
        of: createDoc(),
        is: createTypicalPayload(),
      }));
    const transaction = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from(assertions),
    });
    session.transact(transaction);

    b.start();
    const query = Query.create({
      issuer: alice.did(),
      subject: space.did(),
      select: { _: { [the]: {} } },
    });
    const result = session.query(query);
    b.end();

    if (result.error) throw result.error;
    session.close();
  },
});

// --------------------------------------------------------------------------
// Benchmark: Retract a fact
// --------------------------------------------------------------------------

Deno.bench({
  name: "retract fact (single ~16KB)",
  group: "retract",
  baseline: true,
  async fn(b) {
    const session = await openSpace();
    const doc = createDoc();

    // Setup: create the fact first
    const assertion = Fact.assert({ the, of: doc, is: createTypicalPayload() });
    const createTx = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([assertion]),
    });
    session.transact(createTx);

    b.start();
    const retraction = Fact.retract(assertion);
    const retractTx = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([retraction]),
    });
    const result = session.transact(retractTx);
    b.end();

    if (result.error) throw result.error;
    session.close();
  },
});

Deno.bench({
  name: "retract fact (10 ~16KB retractions batch)",
  group: "retract",
  async fn(b) {
    const session = await openSpace();

    // Setup: create 10 facts first
    const assertions = Array.from({ length: 10 }, () =>
      Fact.assert({
        the,
        of: createDoc(),
        is: createTypicalPayload(),
      }));
    const createTx = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from(assertions),
    });
    session.transact(createTx);

    b.start();
    const retractions = assertions.map((a) => Fact.retract(a));
    const retractTx = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from(retractions),
    });
    const result = session.transact(retractTx);
    b.end();

    if (result.error) throw result.error;
    session.close();
  },
});

// --------------------------------------------------------------------------
// Benchmark: Update fact (set new value with cause chain)
// --------------------------------------------------------------------------

Deno.bench({
  name: "update fact (single ~16KB)",
  group: "update",
  baseline: true,
  async fn(b) {
    const session = await openSpace();
    const doc = createDoc();
    const payload1 = createTypicalPayload();
    const payload2 = createTypicalPayload();

    // Setup: create the initial fact
    const v1 = Fact.assert({ the, of: doc, is: payload1 });
    const createTx = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([v1]),
    });
    session.transact(createTx);

    b.start();
    const v2 = Fact.assert({ the, of: doc, is: payload2, cause: v1 });
    const updateTx = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([v2]),
    });
    const result = session.transact(updateTx);
    b.end();

    if (result.error) throw result.error;
    session.close();
  },
});

Deno.bench({
  name: "update fact (10 sequential ~16KB updates)",
  group: "update",
  async fn(b) {
    const session = await openSpace();
    const doc = createDoc();
    const payloads = Array.from({ length: 11 }, () => createTypicalPayload());

    // Setup: create the initial fact
    let current = Fact.assert({ the, of: doc, is: payloads[0] });
    const createTx = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([current]),
    });
    session.transact(createTx);

    b.start();
    for (let i = 1; i <= 10; i++) {
      const next = Fact.assert({
        the,
        of: doc,
        is: payloads[i],
        cause: current,
      });
      const updateTx = Transaction.create({
        issuer: alice.did(),
        subject: space.did(),
        changes: Changes.from([next]),
      });
      const result = session.transact(updateTx);
      if (result.error) throw result.error;
      current = next;
    }
    b.end();

    session.close();
  },
});

// --------------------------------------------------------------------------
// Benchmark: Combined operations (typical workflow)
// --------------------------------------------------------------------------

Deno.bench({
  name: "workflow: create -> read -> update -> read -> retract (~16KB)",
  group: "workflow",
  async fn(b) {
    const session = await openSpace();
    warmUp(session);

    const doc = createDoc();
    const payload1 = createTypicalPayload();
    const payload2 = createTypicalPayload();

    b.start();
    // Create
    const v1 = Fact.assert({ the, of: doc, is: payload1 });
    const createResult = session.transact(
      Transaction.create({
        issuer: alice.did(),
        subject: space.did(),
        changes: Changes.from([v1]),
      }),
    );

    // Read
    const readResult1 = session.query(
      Query.create({
        issuer: alice.did(),
        subject: space.did(),
        select: { [doc]: { [the]: {} } },
      }),
    );

    // Update
    const v2 = Fact.assert({ the, of: doc, is: payload2, cause: v1 });
    const updateResult = session.transact(
      Transaction.create({
        issuer: alice.did(),
        subject: space.did(),
        changes: Changes.from([v2]),
      }),
    );

    // Read again
    const readResult2 = session.query(
      Query.create({
        issuer: alice.did(),
        subject: space.did(),
        select: { [doc]: { [the]: {} } },
      }),
    );

    // Retract
    const r = Fact.retract(v2);
    const retractResult = session.transact(
      Transaction.create({
        issuer: alice.did(),
        subject: space.did(),
        changes: Changes.from([r]),
      }),
    );
    b.end();

    if (createResult.error) throw createResult.error;
    if (readResult1.error) throw readResult1.error;
    if (updateResult.error) throw updateResult.error;
    if (readResult2.error) throw readResult2.error;
    if (retractResult.error) throw retractResult.error;

    session.close();
  },
});

// --------------------------------------------------------------------------
// Benchmark: Payload sizes (realistic: avg ~16KB)
// --------------------------------------------------------------------------

// Helper to create payloads of approximate sizes
function createPayload(targetBytes: number): JSONValue {
  // JSON overhead means we need to account for keys and structure
  const basePayload = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {
      version: 1,
      type: "document",
      tags: ["benchmark", "test"],
    },
  };

  // Estimate base size and fill with content
  const baseSize = JSON.stringify(basePayload).length;
  const contentSize = Math.max(0, targetBytes - baseSize - 50); // reserve space for content key

  return {
    ...basePayload,
    content: "X".repeat(contentSize),
  };
}

Deno.bench({
  name: "set fact (~4KB payload)",
  group: "payload",
  async fn(b) {
    const session = await openSpace();
    warmUp(session);

    const doc = createDoc();
    const payload = createPayload(4 * 1024);

    b.start();
    const assertion = Fact.assert({
      the,
      of: doc,
      is: payload,
    });

    const transaction = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([assertion]),
    });

    session.transact(transaction);
    b.end();

    session.close();
  },
});

Deno.bench({
  name: "set fact (~16KB payload - typical)",
  group: "payload",
  baseline: true,
  async fn(b) {
    const session = await openSpace();
    warmUp(session);

    const doc = createDoc();
    const payload = createPayload(16 * 1024);

    b.start();
    const assertion = Fact.assert({
      the,
      of: doc,
      is: payload,
    });

    const transaction = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([assertion]),
    });

    session.transact(transaction);
    b.end();

    session.close();
  },
});

Deno.bench({
  name: "set fact (~64KB payload)",
  group: "payload",
  async fn(b) {
    const session = await openSpace();
    warmUp(session);

    const doc = createDoc();
    const payload = createPayload(64 * 1024);

    b.start();
    const assertion = Fact.assert({
      the,
      of: doc,
      is: payload,
    });

    const transaction = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([assertion]),
    });

    session.transact(transaction);
    b.end();

    session.close();
  },
});

Deno.bench({
  name: "set fact (~256KB payload)",
  group: "payload",
  async fn(b) {
    const session = await openSpace();
    warmUp(session);

    const doc = createDoc();
    const payload = createPayload(256 * 1024);

    b.start();
    const assertion = Fact.assert({
      the,
      of: doc,
      is: payload,
    });

    const transaction = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([assertion]),
    });

    session.transact(transaction);
    b.end();

    session.close();
  },
});

// --------------------------------------------------------------------------
// Benchmark: Pre-populated database queries
// --------------------------------------------------------------------------

// Create a session with 1000 ~16KB facts pre-populated
let prepopulatedSession: Space.View | null = null;
let prepopulatedDocs: `of:${string}`[] = [];

async function getOrCreatePrepopulatedSession() {
  if (!prepopulatedSession) {
    const result = await Space.open({
      url: new URL(`memory:${space.did()}-prepopulated`),
    });
    if (result.error) throw result.error;
    prepopulatedSession = result.ok;

    // Create 1000 ~16KB facts
    prepopulatedDocs = Array.from({ length: 1000 }, () => createDoc());
    const assertions = prepopulatedDocs.map((doc) =>
      Fact.assert({ the, of: doc, is: createTypicalPayload() })
    );

    // Batch insert in groups of 100
    for (let i = 0; i < assertions.length; i += 100) {
      const batch = assertions.slice(i, i + 100);
      prepopulatedSession.transact(
        Transaction.create({
          issuer: alice.did(),
          subject: space.did(),
          changes: Changes.from(batch),
        }),
      );
    }
  }
  return { session: prepopulatedSession, docs: prepopulatedDocs };
}

Deno.bench({
  name: "query single ~16KB doc (from 1000 docs)",
  group: "scale",
  baseline: true,
  async fn(b) {
    const { session, docs } = await getOrCreatePrepopulatedSession();
    const randomDoc = docs[Math.floor(Math.random() * docs.length)];

    b.start();
    const query = Query.create({
      issuer: alice.did(),
      subject: space.did(),
      select: { [randomDoc]: { [the]: {} } },
    });
    session.query(query);
    b.end();
  },
});

Deno.bench({
  name: "wildcard query all (1000 ~16KB docs)",
  group: "scale",
  async fn(b) {
    const { session } = await getOrCreatePrepopulatedSession();

    b.start();
    const query = Query.create({
      issuer: alice.did(),
      subject: space.did(),
      select: { _: { [the]: {} } },
    });
    session.query(query);
    b.end();
  },
});

Deno.bench({
  name: "insert ~16KB into populated db (1000 existing docs)",
  group: "scale",
  async fn(b) {
    const { session } = await getOrCreatePrepopulatedSession();
    const doc = createDoc();
    const payload = createTypicalPayload();

    b.start();
    const assertion = Fact.assert({
      the,
      of: doc,
      is: payload,
    });

    session.transact(
      Transaction.create({
        issuer: alice.did(),
        subject: space.did(),
        changes: Changes.from([assertion]),
      }),
    );
    b.end();
  },
});

// ==========================================================================
// ISOLATION BENCHMARKS: Identify where time is spent
// ==========================================================================

// --------------------------------------------------------------------------
// Baseline: Raw SQLite performance
// --------------------------------------------------------------------------

const RAW_SCHEMA = `
  CREATE TABLE IF NOT EXISTS test_datum (
    id TEXT PRIMARY KEY,
    data TEXT
  );
`;

let rawDb: Database | null = null;
let rawInsertStmt: ReturnType<Database["prepare"]> | null = null;

function getRawDb() {
  if (!rawDb) {
    rawDb = new Database(":memory:");
    rawDb.exec(RAW_SCHEMA);
    // Warm up with one insert
    rawDb.run("INSERT INTO test_datum (id, data) VALUES (?, ?)", [
      "warmup",
      "{}",
    ]);
    rawInsertStmt = rawDb.prepare(
      "INSERT INTO test_datum (id, data) VALUES (?, ?)",
    );
  }
  return { db: rawDb, stmt: rawInsertStmt! };
}

Deno.bench({
  name: "raw SQLite INSERT (16KB, prepared stmt)",
  group: "isolation",
  baseline: true,
  fn(b) {
    const { stmt } = getRawDb();
    const id = `id-${docCounter++}`;
    const payload = createTypicalPayload();
    const json = JSON.stringify(payload);

    b.start();
    stmt.run([id, json]);
    b.end();
  },
});

Deno.bench({
  name: "raw SQLite INSERT (16KB, new stmt each time)",
  group: "isolation",
  fn(b) {
    const { db } = getRawDb();
    const id = `id-${docCounter++}`;
    const payload = createTypicalPayload();
    const json = JSON.stringify(payload);

    b.start();
    db.run("INSERT INTO test_datum (id, data) VALUES (?, ?)", [id, json]);
    b.end();
  },
});

// --------------------------------------------------------------------------
// Isolation: JSON.stringify cost
// --------------------------------------------------------------------------

Deno.bench({
  name: "JSON.stringify (16KB payload)",
  group: "isolation",
  fn(b) {
    const payload = createTypicalPayload();

    b.start();
    JSON.stringify(payload);
    b.end();
  },
});

// --------------------------------------------------------------------------
// Isolation: Merkle reference (refer) cost
// --------------------------------------------------------------------------

Deno.bench({
  name: "refer() on 4KB payload",
  group: "refer-scaling",
  fn(b) {
    const payload = createPayload(4 * 1024);

    b.start();
    refer(payload);
    b.end();
  },
});

Deno.bench({
  name: "refer() on 16KB payload",
  group: "refer-scaling",
  baseline: true,
  fn(b) {
    const payload = createPayload(16 * 1024);

    b.start();
    refer(payload);
    b.end();
  },
});

Deno.bench({
  name: "refer() on 64KB payload",
  group: "refer-scaling",
  fn(b) {
    const payload = createPayload(64 * 1024);

    b.start();
    refer(payload);
    b.end();
  },
});

Deno.bench({
  name: "refer() on 256KB payload",
  group: "refer-scaling",
  fn(b) {
    const payload = createPayload(256 * 1024);

    b.start();
    refer(payload);
    b.end();
  },
});

Deno.bench({
  name: "refer() on 16KB payload (isolation)",
  group: "isolation",
  fn(b) {
    const payload = createTypicalPayload();

    b.start();
    refer(payload);
    b.end();
  },
});

Deno.bench({
  name: "refer() on small object {the, of}",
  group: "isolation",
  fn(b) {
    const doc = createDoc();

    b.start();
    refer({ the: "application/json", of: doc });
    b.end();
  },
});

Deno.bench({
  name: "refer() on assertion (16KB is + metadata)",
  group: "isolation",
  fn(b) {
    const doc = createDoc();
    const payload = createTypicalPayload();

    b.start();
    refer({ the: "application/json", of: doc, is: payload });
    b.end();
  },
});

// --------------------------------------------------------------------------
// Isolation: Fact.assert cost (creates merkle refs internally)
// --------------------------------------------------------------------------

Deno.bench({
  name: "Fact.assert() call only",
  group: "isolation",
  fn(b) {
    const doc = createDoc();
    const payload = createTypicalPayload();

    b.start();
    Fact.assert({
      the: "application/json",
      of: doc,
      is: payload,
    });
    b.end();
  },
});

// --------------------------------------------------------------------------
// Isolation: Transaction.create cost
// --------------------------------------------------------------------------

Deno.bench({
  name: "Transaction.create() + Changes.from()",
  group: "isolation",
  fn(b) {
    const doc = createDoc();
    const payload = createTypicalPayload();
    const assertion = Fact.assert({
      the: "application/json",
      of: doc,
      is: payload,
    });

    b.start();
    Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([assertion]),
    });
    b.end();
  },
});

// --------------------------------------------------------------------------
// Combined: Multiple refer() calls as done in a real transaction
// --------------------------------------------------------------------------

Deno.bench({
  name: "3x refer() calls (simulating transaction)",
  group: "isolation",
  fn(b) {
    const doc = createDoc();
    const payload = createTypicalPayload();

    b.start();
    // Simulates what happens in a transaction:
    // 1. refer(datum) for the payload
    refer(payload);
    // 2. refer(unclaimed) for the base
    refer({ the: "application/json", of: doc });
    // 3. refer(assertion) for the fact
    refer({ the: "application/json", of: doc, is: payload });
    b.end();
  },
});

// Test memoization benefit: same content referenced multiple times
import { refer as memoizedRefer } from "../reference.ts";
import { unclaimedRef } from "../fact.ts";

Deno.bench({
  name: "memoized: 3x refer() same payload (cache hits)",
  group: "isolation",
  fn(b) {
    const doc = createDoc();
    const payload = createTypicalPayload();

    // First call populates cache
    memoizedRefer(payload);
    memoizedRefer({ the: "application/json", of: doc });

    b.start();
    // These should be cache hits
    memoizedRefer(payload);
    memoizedRefer({ the: "application/json", of: doc });
    memoizedRefer(payload);
    b.end();
  },
});

Deno.bench({
  name: "memoized: repeated unclaimed refs (common pattern)",
  group: "isolation",
  fn(b) {
    const doc = createDoc();

    // Warm cache
    unclaimedRef({ the: "application/json" as const, of: doc });

    b.start();
    // Simulates multiple unclaimed refs in transaction flow
    // Uses unclaimedRef() which caches by {the, of} key
    for (let i = 0; i < 10; i++) {
      unclaimedRef({ the: "application/json" as const, of: doc });
    }
    b.end();
  },
});

// ==========================================================================
// FILE-BASED BENCHMARKS: Test real WAL/pragma impact
// ==========================================================================

const benchDir = Deno.makeTempDirSync({ prefix: "memory-bench-" });
let fileDbCounter = 0;

// Helper to open a fresh file-based space
async function openFileSpace() {
  // DID must be in pathname - format: file:///path/to/did:key:xxx.sqlite
  const dbPath = `${benchDir}/${space.did()}-${fileDbCounter++}.sqlite`;
  const result = await Space.open({
    url: new URL(`file://${dbPath}`),
  });
  if (result.error) throw result.error;
  return result.ok;
}

Deno.bench({
  name: "file: set fact (single ~16KB assertion)",
  group: "file-set",
  baseline: true,
  async fn(b) {
    const session = await openFileSpace();
    warmUp(session);

    const doc = createDoc();
    const payload = createTypicalPayload();

    b.start();
    const assertion = Fact.assert({
      the,
      of: doc,
      is: payload,
    });

    const transaction = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([assertion]),
    });

    const result = session.transact(transaction);
    b.end();

    if (result.error) throw result.error;
    session.close();
  },
});

Deno.bench({
  name: "file: set fact (10 ~16KB assertions batch)",
  group: "file-set",
  async fn(b) {
    const session = await openFileSpace();
    warmUp(session);

    const docs = Array.from({ length: 10 }, () => createDoc());
    const payloads = Array.from({ length: 10 }, () => createTypicalPayload());

    b.start();
    const assertions = docs.map((doc, i) =>
      Fact.assert({
        the,
        of: doc,
        is: payloads[i],
      })
    );

    const transaction = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from(assertions),
    });

    const result = session.transact(transaction);
    b.end();

    if (result.error) throw result.error;
    session.close();
  },
});

Deno.bench({
  name: "file: set fact (100 ~16KB assertions batch)",
  group: "file-set",
  async fn(b) {
    const session = await openFileSpace();
    warmUp(session);

    const docs = Array.from({ length: 100 }, () => createDoc());
    const payloads = Array.from({ length: 100 }, () => createTypicalPayload());

    b.start();
    const assertions = docs.map((doc, i) =>
      Fact.assert({
        the,
        of: doc,
        is: payloads[i],
      })
    );

    const transaction = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from(assertions),
    });

    const result = session.transact(transaction);
    b.end();

    if (result.error) throw result.error;
    session.close();
  },
});

// File-based get benchmarks
Deno.bench({
  name: "file: get fact (single ~16KB query)",
  group: "file-get",
  baseline: true,
  async fn(b) {
    const session = await openFileSpace();
    const doc = createDoc();

    // Setup: create the fact first
    const assertion = Fact.assert({ the, of: doc, is: createTypicalPayload() });
    const transaction = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([assertion]),
    });
    session.transact(transaction);

    b.start();
    const query = Query.create({
      issuer: alice.did(),
      subject: space.did(),
      select: { [doc]: { [the]: {} } },
    });
    const result = session.query(query);
    b.end();

    if (result.error) throw result.error;
    session.close();
  },
});

Deno.bench({
  name: "file: get fact (wildcard query 100 ~16KB docs)",
  group: "file-get",
  async fn(b) {
    const session = await openFileSpace();

    // Setup: create 100 facts
    const assertions = Array.from({ length: 100 }, () =>
      Fact.assert({
        the,
        of: createDoc(),
        is: createTypicalPayload(),
      }));
    const transaction = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from(assertions),
    });
    session.transact(transaction);

    b.start();
    const query = Query.create({
      issuer: alice.did(),
      subject: space.did(),
      select: { _: { [the]: {} } },
    });
    const result = session.query(query);
    b.end();

    if (result.error) throw result.error;
    session.close();
  },
});

// File-based update benchmark
Deno.bench({
  name: "file: update fact (single ~16KB)",
  group: "file-update",
  baseline: true,
  async fn(b) {
    const session = await openFileSpace();
    const doc = createDoc();
    const payload1 = createTypicalPayload();
    const payload2 = createTypicalPayload();

    // Setup: create the initial fact
    const v1 = Fact.assert({ the, of: doc, is: payload1 });
    const createTx = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([v1]),
    });
    session.transact(createTx);

    b.start();
    const v2 = Fact.assert({ the, of: doc, is: payload2, cause: v1 });
    const updateTx = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([v2]),
    });
    const result = session.transact(updateTx);
    b.end();

    if (result.error) throw result.error;
    session.close();
  },
});

Deno.bench({
  name: "file: update fact (10 sequential ~16KB updates)",
  group: "file-update",
  async fn(b) {
    const session = await openFileSpace();
    const doc = createDoc();
    const payloads = Array.from({ length: 11 }, () => createTypicalPayload());

    // Setup: create the initial fact
    let current = Fact.assert({ the, of: doc, is: payloads[0] });
    const createTx = Transaction.create({
      issuer: alice.did(),
      subject: space.did(),
      changes: Changes.from([current]),
    });
    session.transact(createTx);

    b.start();
    for (let i = 1; i <= 10; i++) {
      const next = Fact.assert({
        the,
        of: doc,
        is: payloads[i],
        cause: current,
      });
      const updateTx = Transaction.create({
        issuer: alice.did(),
        subject: space.did(),
        changes: Changes.from([next]),
      });
      const result = session.transact(updateTx);
      if (result.error) throw result.error;
      current = next;
    }
    b.end();

    session.close();
  },
});

// File-based workflow benchmark
Deno.bench({
  name: "file: workflow: create -> read -> update -> read -> retract",
  group: "file-workflow",
  async fn(b) {
    const session = await openFileSpace();
    warmUp(session);

    const doc = createDoc();
    const payload1 = createTypicalPayload();
    const payload2 = createTypicalPayload();

    b.start();
    // Create
    const v1 = Fact.assert({ the, of: doc, is: payload1 });
    const createResult = session.transact(
      Transaction.create({
        issuer: alice.did(),
        subject: space.did(),
        changes: Changes.from([v1]),
      }),
    );

    // Read
    const readResult1 = session.query(
      Query.create({
        issuer: alice.did(),
        subject: space.did(),
        select: { [doc]: { [the]: {} } },
      }),
    );

    // Update
    const v2 = Fact.assert({ the, of: doc, is: payload2, cause: v1 });
    const updateResult = session.transact(
      Transaction.create({
        issuer: alice.did(),
        subject: space.did(),
        changes: Changes.from([v2]),
      }),
    );

    // Read again
    const readResult2 = session.query(
      Query.create({
        issuer: alice.did(),
        subject: space.did(),
        select: { [doc]: { [the]: {} } },
      }),
    );

    // Retract
    const r = Fact.retract(v2);
    const retractResult = session.transact(
      Transaction.create({
        issuer: alice.did(),
        subject: space.did(),
        changes: Changes.from([r]),
      }),
    );
    b.end();

    if (createResult.error) throw createResult.error;
    if (readResult1.error) throw readResult1.error;
    if (updateResult.error) throw updateResult.error;
    if (readResult2.error) throw readResult2.error;
    if (retractResult.error) throw retractResult.error;

    session.close();
  },
});
