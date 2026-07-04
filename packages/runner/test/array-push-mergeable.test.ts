import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import { TransactionWrapper } from "../src/storage/extended-storage-transaction.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";
import type { JSONSchema } from "../src/builder/types.ts";

// A storage manager with its OWN per-space client replicas, loopback-connected
// to a SHARED in-process memory server (mirrors cross-space-value-read.test.ts).
// Two of these connected to one server model two real sessions: data written by
// one session reaches the other only through an explicit per-space server
// query/subscription.
class SharedServerStorageManager extends EmulatedStorageManager {
  static connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    const manager = new SharedServerStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      () => server,
    );
    manager.sharedServer = server;
    return manager;
  }

  private sharedServer!: MemoryV2Server.Server;

  protected override server(): MemoryV2Server.Server {
    return this.sharedServer;
  }
}

const newSharedServer = () =>
  new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });

const signer = await Identity.fromPassphrase("array-push-mergeable");
const space = signer.did();
const CAUSE = "mergeable-append-list";
const COUNTER_CAUSE = "mergeable-counter";

const stringListSchema = {
  type: "array",
  items: { type: "string" },
} satisfies JSONSchema;

const numberSchema = {
  type: "number",
} satisfies JSONSchema;

// A permissive schema that accepts any value, so a cell can hold a scalar that
// the array/number mergeable methods then reject.
const anySchema = {} satisfies JSONSchema;

// Read the durable array from a fresh session that pulls it straight off the
// shared server, so the assertion reflects committed/durable state rather than
// any one writer's optimistic local view.
async function readDurable(
  server: MemoryV2Server.Server,
): Promise<string[]> {
  const storage = SharedServerStorageManager.connectTo(server, { as: signer });
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  try {
    const cell = rt.getCell<string[]>(space, CAUSE, stringListSchema);
    await cell.sync();
    await cell.pull();
    return (cell.get() ?? []) as string[];
  } finally {
    await rt.dispose();
    await storage.close();
  }
}

async function readDurableNumber(
  server: MemoryV2Server.Server,
): Promise<number | undefined> {
  const storage = SharedServerStorageManager.connectTo(server, { as: signer });
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  try {
    const cell = rt.getCell<number>(space, COUNTER_CAUSE, numberSchema);
    await cell.sync();
    await cell.pull();
    return cell.get();
  } finally {
    await rt.dispose();
    await storage.close();
  }
}

describe("mergeable array appends", () => {
  let server: MemoryV2Server.Server;
  let storage1: SharedServerStorageManager;
  let storage2: SharedServerStorageManager;

  beforeEach(() => {
    server = newSharedServer();
    storage1 = SharedServerStorageManager.connectTo(server, { as: signer });
    storage2 = SharedServerStorageManager.connectTo(server, { as: signer });
  });
  afterEach(async () => {
    await storage1?.close();
    await storage2?.close();
    await server?.close();
  });

  // Two sessions append to the same list against the SAME base, neither having
  // observed the other's append before committing. Both appends represent real
  // user intent on disjoint tail slots, so both must survive durably.
  it("two concurrent appends to the same list both survive", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      // Seed the list with one element and get it durable on the server.
      const tx0 = rt1.edit();
      const seedCell = rt1.getCell<string[]>(
        space,
        CAUSE,
        stringListSchema,
        tx0,
      );
      seedCell.set(["seed"]);
      await tx0.commit();
      await rt1.storageManager.synced();

      // Both sessions load the seeded list. After this both replicas hold
      // ["seed"] at the same basis sequence.
      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();
      expect(cell2.get()).toEqual(["seed"]);

      // Session 1 appends "A".
      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA).push("A");
      await txA.commit();
      await rt1.storageManager.synced();

      // Session 2 appends "B" WITHOUT having observed session 1's "A": its
      // replica still holds ["seed"] at the pre-"A" basis.
      const txB = rt2.edit();
      rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB).push("B");
      await txB.commit();
      await rt2.storageManager.synced();

      const durable = await readDurable(server);
      expect(durable.length).toBe(3);
      expect(durable).toContain("seed");
      expect(durable).toContain("A");
      expect(durable).toContain("B");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  // The same merge must hold when the append goes through the query-result proxy
  // (a handler's `arr.push(x)` on a reactive array) rather than Cell.push. The
  // proxy marks its own base-array read as the op's incidental read; without that
  // mark the read enters the conflict set, session 2's commit false-conflicts
  // against session 1's "A", and "B" is dropped instead of merging.
  it("a concurrent proxy push merges alongside another append", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["seed"]);
      await tx0.commit();
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA).push("A");
      await txA.commit();
      await rt1.storageManager.synced();

      // Session 2 appends "B" through the proxy while still at the pre-"A" basis.
      const txB = rt2.edit();
      const proxy = rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB)
        .getAsQueryResult([], txB, true) as unknown as string[];
      proxy.push("B");
      await txB.commit();
      await rt2.storageManager.synced();

      expect([...await readDurable(server)].sort()).toEqual(["A", "B", "seed"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  // A CONDITIONAL push — the handler reads the list explicitly before pushing
  // (the dedup-then-push shape) — must keep its read in the conflict set, so a
  // concurrent append makes it conflict (and, in the live system, retry). This
  // is the opposite of the unconditional case above, which merges. It proves the
  // read drop is scoped to the op's own reads, not the handler's explicit read.
  it("a conditional push (explicit read before push) conflicts with a concurrent append", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["seed"]);
      await tx0.commit();
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      // Session 1 appends "A".
      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA).push("A");
      await txA.commit();
      await rt1.storageManager.synced();

      // Session 2, still at the pre-"A" basis, reads the list explicitly and
      // then pushes — the dedup-then-push shape. The explicit read is retained,
      // so the commit conflicts with session 1's append.
      const txB = rt2.edit();
      const cellB = rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB);
      cellB.get();
      cellB.push("B");
      const result = await txB.commit();

      expect(result.error).toBeDefined();
      const durable = await readDurable(server);
      expect(durable).toEqual(["seed", "A"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  // A single session appends to a list whose durable head it has not yet
  // observed (the rehydration-race shape): it reads the list as shorter/empty
  // than it durably is, then appends. The append must land at the durable tail,
  // never clobbering elements it could not see.
  it("an append against a stale-short base does not clobber the durable tail", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      // Session 2 establishes a replica of the (initially empty) entity.
      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();

      // Session 1 creates the list with two durable elements.
      const tx0 = rt1.edit();
      const seedCell = rt1.getCell<string[]>(
        space,
        CAUSE,
        stringListSchema,
        tx0,
      );
      seedCell.set(["one", "two"]);
      await tx0.commit();
      await rt1.storageManager.synced();

      // Session 2 appends "three" while its replica is still stale-short (it has
      // not pulled ["one","two"]).
      const txB = rt2.edit();
      rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB).push("three");
      await txB.commit();
      await rt2.storageManager.synced();

      const durable = await readDurable(server);
      expect(durable).toContain("one");
      expect(durable).toContain("two");
      expect(durable).toContain("three");
      expect(durable.length).toBe(3);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  // A single transaction that both edits an existing element and appends must
  // keep the edit: the append op covers only the appended tail, not the edited
  // prefix slot.
  it("an edit to an existing element survives alongside a push in the same tx", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const tx0 = rt1.edit();
      const seedCell = rt1.getCell<string[]>(
        space,
        CAUSE,
        stringListSchema,
        tx0,
      );
      seedCell.set(["one", "two"]);
      await tx0.commit();
      await rt1.storageManager.synced();

      const tx1 = rt1.edit();
      const cell = rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx1);
      cell.key(0).set("ONE");
      cell.push("three");
      await tx1.commit();
      await rt1.storageManager.synced();

      const durable = await readDurable(server);
      expect(durable).toEqual(["ONE", "two", "three"]);
    } finally {
      await rt1.dispose();
    }
  });

  // Two sessions add distinct elements to the same set against the same base.
  // Both are real intents on the set, so both must survive.
  it("two concurrent add-uniques of distinct elements both survive", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["seed"]);
      await tx0.commit();
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA).addUnique("A");
      await txA.commit();
      await rt1.storageManager.synced();

      // rt2 still holds ["seed"] (has not observed "A").
      const txB = rt2.edit();
      rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB).addUnique("B");
      await txB.commit();
      await rt2.storageManager.synced();

      const durable = await readDurable(server);
      expect(durable.length).toBe(3);
      expect(durable).toContain("seed");
      expect(durable).toContain("A");
      expect(durable).toContain("B");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  // Two sessions add the SAME element against the same base. add-unique dedups
  // against durable state on the server, so the element appears once.
  it("concurrent add-unique of the same element is idempotent", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["seed"]);
      await tx0.commit();
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA).addUnique("X");
      await txA.commit();
      await rt1.storageManager.synced();

      // rt2 adds "X" too, against its stale ["seed"] base — it never observed
      // rt1's add.
      const txB = rt2.edit();
      rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB).addUnique("X");
      await txB.commit();
      await rt2.storageManager.synced();

      const durable = await readDurable(server);
      expect(durable).toEqual(["seed", "X"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  // Two sessions increment the same counter against the same base. Increments
  // sum against durable state rather than clobber via last-write-wins.
  it("two concurrent increments sum", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<number>(space, COUNTER_CAUSE, numberSchema, tx0).set(0);
      await tx0.commit();
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<number>(space, COUNTER_CAUSE, numberSchema);
      await cell2.sync();
      await cell2.pull();
      expect(cell2.get()).toBe(0);

      const txA = rt1.edit();
      rt1.getCell<number>(space, COUNTER_CAUSE, numberSchema, txA).increment(1);
      await txA.commit();
      await rt1.storageManager.synced();

      // rt2 still reads 0 (has not observed rt1's increment).
      const txB = rt2.edit();
      rt2.getCell<number>(space, COUNTER_CAUSE, numberSchema, txB).increment(1);
      await txB.commit();
      await rt2.storageManager.synced();

      expect(await readDurableNumber(server)).toBe(2);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  // Incrementing a counter that was never set treats the missing value as a
  // zero default: the durable value becomes the increment amount.
  it("increment on a missing value implies a zero default", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const tx = rt1.edit();
      rt1.getCell<number>(space, COUNTER_CAUSE, numberSchema, tx).increment(5);
      await tx.commit();
      await rt1.storageManager.synced();

      expect(await readDurableNumber(server)).toBe(5);
    } finally {
      await rt1.dispose();
    }
  });

  // Two sessions remove distinct elements concurrently; both removals must land
  // (they merge against durable state rather than clobber via a whole-array set).
  it("two concurrent removeByValue of distinct elements both land", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set([
        "a",
        "b",
        "c",
      ]);
      await tx0.commit();
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA)
        .removeByValue("a");
      await txA.commit();
      await rt1.storageManager.synced();

      // rt2, still holding ["a","b","c"], removes a different element.
      const txB = rt2.edit();
      rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB)
        .removeByValue("c");
      await txB.commit();
      await rt2.storageManager.synced();

      expect(await readDurable(server)).toEqual(["b"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  // A zero increment is a programming no-op and is rejected.
  it("increment(0) throws", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    try {
      const tx = rt1.edit();
      const cell = rt1.getCell<number>(space, COUNTER_CAUSE, numberSchema, tx);
      expect(() => cell.increment(0)).toThrow();
      await tx.commit();
    } finally {
      await rt1.dispose();
    }
  });
});

// A "keyed collection": a list whose elements are separate entities, each
// addressed by a deterministic key via `elementById`. The handler reads/edits
// one element by key and manages membership with addUnique / removeByValue,
// never reading or rewriting the whole list. This is the lunch poll's vote and
// option model.
interface Vote {
  voterName: string;
  optionId: string;
  voteType: string;
}

const VOTES_CAUSE = "keyed-votes";

const voteListSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      voterName: { type: "string" },
      optionId: { type: "string" },
      voteType: { type: "string" },
    },
  },
} satisfies JSONSchema;

// Read the durable list from a fresh session and resolve each element link to
// its content, so assertions reflect committed state, link-resolved.
async function readDurableVotes(
  server: MemoryV2Server.Server,
): Promise<Vote[]> {
  const storage = SharedServerStorageManager.connectTo(server, { as: signer });
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  try {
    const cell = rt.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema);
    await cell.sync();
    await cell.pull();
    return (cell.get() ?? []) as Vote[];
  } finally {
    await rt.dispose();
    await storage.close();
  }
}

describe("keyed collections via elementById", () => {
  let server: MemoryV2Server.Server;
  let storage1: SharedServerStorageManager;
  let storage2: SharedServerStorageManager;

  beforeEach(() => {
    server = newSharedServer();
    storage1 = SharedServerStorageManager.connectTo(server, { as: signer });
    storage2 = SharedServerStorageManager.connectTo(server, { as: signer });
  });
  afterEach(async () => {
    await storage1?.close();
    await storage2?.close();
    await server?.close();
  });

  // The key resolves to the same entity in a session that never saw the write,
  // so a second session can read and then remove the element purely by key.
  it("an element addressed by key is readable and removable from another session", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      const votes0 = rt1.getCell<Vote[]>(
        space,
        VOTES_CAUSE,
        voteListSchema,
        tx0,
      );
      votes0.set([]);
      const vote = votes0.elementById("alice|opt1");
      vote.set({ voterName: "alice", optionId: "opt1", voteType: "yes" });
      votes0.addUnique(vote);
      await tx0.commit();
      await rt1.storageManager.synced();

      // Session 2, which never observed the write, addresses the same vote by
      // the same key and reads its content.
      const votes2 = rt2.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema);
      await votes2.sync();
      await votes2.pull();
      const mine = votes2.elementById("alice|opt1");
      expect(mine.get()).toEqual({
        voterName: "alice",
        optionId: "opt1",
        voteType: "yes",
      });

      // It removes the element by key alone, never rewriting the list.
      const txR = rt2.edit();
      rt2.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema, txR)
        .removeByValue(
          rt2.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema, txR)
            .elementById("alice|opt1"),
        );
      await txR.commit();
      await rt2.storageManager.synced();

      expect(await readDurableVotes(server)).toEqual([]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  // Two sessions cast votes under different keys against the same base; both
  // memberships merge instead of clobbering.
  it("two sessions add distinct keyed elements concurrently — both survive", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema, tx0).set([]);
      await tx0.commit();
      await rt1.storageManager.synced();

      const votes2 = rt2.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema);
      await votes2.sync();
      await votes2.pull();

      const txA = rt1.edit();
      const votesA = rt1.getCell<Vote[]>(
        space,
        VOTES_CAUSE,
        voteListSchema,
        txA,
      );
      const a = votesA.elementById("alice|opt1");
      a.set({ voterName: "alice", optionId: "opt1", voteType: "yes" });
      votesA.addUnique(a);
      await txA.commit();
      await rt1.storageManager.synced();

      // Session 2, still at the empty base, adds a different key.
      const txB = rt2.edit();
      const votesB = rt2.getCell<Vote[]>(
        space,
        VOTES_CAUSE,
        voteListSchema,
        txB,
      );
      const b = votesB.elementById("bob|opt2");
      b.set({ voterName: "bob", optionId: "opt2", voteType: "no" });
      votesB.addUnique(b);
      await txB.commit();
      await rt2.storageManager.synced();

      const durable = await readDurableVotes(server);
      expect(durable.length).toBe(2);
      expect(durable).toContainEqual({
        voterName: "alice",
        optionId: "opt1",
        voteType: "yes",
      });
      expect(durable).toContainEqual({
        voterName: "bob",
        optionId: "opt2",
        voteType: "no",
      });
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  // Two sessions cast the same vote (same key) concurrently. The key derives to
  // the same entity, so add-unique dedups by link to a single membership entry.
  it("two sessions add the same keyed element concurrently — dedups to one", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema, tx0).set([]);
      await tx0.commit();
      await rt1.storageManager.synced();

      const votes2 = rt2.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema);
      await votes2.sync();
      await votes2.pull();

      const txA = rt1.edit();
      const votesA = rt1.getCell<Vote[]>(
        space,
        VOTES_CAUSE,
        voteListSchema,
        txA,
      );
      const a = votesA.elementById("alice|opt1");
      a.set({ voterName: "alice", optionId: "opt1", voteType: "yes" });
      votesA.addUnique(a);
      await txA.commit();
      await rt1.storageManager.synced();

      const txB = rt2.edit();
      const votesB = rt2.getCell<Vote[]>(
        space,
        VOTES_CAUSE,
        voteListSchema,
        txB,
      );
      const b = votesB.elementById("alice|opt1");
      b.set({ voterName: "alice", optionId: "opt1", voteType: "yes" });
      votesB.addUnique(b);
      await txB.commit();
      await rt2.storageManager.synced();

      const durable = await readDurableVotes(server);
      expect(durable.length).toBe(1);
      expect(durable[0]).toEqual({
        voterName: "alice",
        optionId: "opt1",
        voteType: "yes",
      });
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  // Editing a field of one keyed entity touches that entity's document, not the
  // list, so a concurrent edit to a different field of the same entity merges.
  it("concurrent edits to different fields of one keyed element both land", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      const votes0 = rt1.getCell<Vote[]>(
        space,
        VOTES_CAUSE,
        voteListSchema,
        tx0,
      );
      votes0.set([]);
      const vote = votes0.elementById("alice|opt1");
      vote.set({ voterName: "alice", optionId: "opt1", voteType: "yes" });
      votes0.addUnique(vote);
      await tx0.commit();
      await rt1.storageManager.synced();

      const votes2 = rt2.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema);
      await votes2.sync();
      await votes2.pull();

      // Session 1 edits the voteType field of the keyed entity.
      const txA = rt1.edit();
      rt1.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema, txA)
        .elementById("alice|opt1").key("voteType").set("no");
      await txA.commit();
      await rt1.storageManager.synced();

      // Session 2, still at the pre-edit basis, edits a different field.
      const txB = rt2.edit();
      rt2.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema, txB)
        .elementById("alice|opt1").key("voterName").set("alice2");
      await txB.commit();
      await rt2.storageManager.synced();

      const durable = await readDurableVotes(server);
      expect(durable.length).toBe(1);
      expect(durable[0]).toEqual({
        voterName: "alice2",
        optionId: "opt1",
        voteType: "no",
      });
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});

// Single-session checks of the mergeable methods' guards and minority branches:
// the transaction/shape preconditions, the absent-array initialization, the
// cell-reference (keyed-entity) matching path used by addUnique/removeByValue,
// the no-op early returns, the element-schema `$defs` carry-through, and the
// in-transaction accumulation of repeated ops on one path. These do not need
// concurrency, only the op machinery, so they run against a single runtime.
describe("mergeable op guards and single-session branches", () => {
  let server: MemoryV2Server.Server;
  let storage1: SharedServerStorageManager;
  let rt: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    storage1 = SharedServerStorageManager.connectTo(server, { as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
  });
  afterEach(async () => {
    await rt?.dispose();
    await storage1?.close();
    await server?.close();
  });

  it("addUnique without a transaction throws", () => {
    const cell = rt.getCell<string[]>(space, CAUSE, stringListSchema);
    expect(() => cell.addUnique("x")).toThrow();
  });

  it("increment without a transaction throws", () => {
    const cell = rt.getCell<number>(space, COUNTER_CAUSE, numberSchema);
    expect(() => cell.increment(1)).toThrow();
  });

  it("removeByValue without a transaction throws", () => {
    const cell = rt.getCell<string[]>(space, CAUSE, stringListSchema);
    expect(() => cell.removeByValue("x")).toThrow();
  });

  it("addUnique onto a non-array value throws", () => {
    const tx = rt.edit();
    const cell = rt.getCell<unknown[] | number>(
      space,
      "scalar-au",
      anySchema,
      tx,
    );
    cell.set(7);
    expect(() => cell.addUnique("x")).toThrow();
  });

  it("increment onto a non-number value throws", () => {
    const tx = rt.edit();
    const cell = rt.getCell<number | string>(
      space,
      "scalar-inc",
      anySchema,
      tx,
    );
    cell.set("not-a-number");
    expect(() => cell.increment(1)).toThrow();
  });

  it("removeByValue onto a non-array value throws", () => {
    const tx = rt.edit();
    const cell = rt.getCell<unknown[] | number>(
      space,
      "scalar-rm",
      anySchema,
      tx,
    );
    cell.set(7);
    expect(() => cell.removeByValue("x")).toThrow();
  });

  it("addUnique initializes an absent array before adding", () => {
    const tx = rt.edit();
    const cell = rt.getCell<string[]>(space, "fresh-au", stringListSchema, tx);
    cell.addUnique("x");
    expect(cell.get()).toEqual(["x"]);
  });

  it("push with no items is a no-op", async () => {
    const tx0 = rt.edit();
    rt.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["a"]);
    await tx0.commit();
    await rt.storageManager.synced();

    const tx = rt.edit();
    rt.getCell<string[]>(space, CAUSE, stringListSchema, tx).push();
    await tx.commit();
    await rt.storageManager.synced();

    expect(await readDurable(server)).toEqual(["a"]);
  });

  it("elementById tolerates a non-record schema", () => {
    const tx = rt.edit();
    // A boolean schema (`true`) is a valid JSON schema but not a record, so the
    // derived element schema is absent.
    const cell = rt.getCell<unknown>(space, "bool-schema", true, tx);
    cell.set([{ a: 1 }]);
    const element = cell.elementById("k1");
    element.set({ a: 2 });
    expect(element.get()).toEqual({ a: 2 });
  });

  it("removeByValue on an absent array is a no-op", () => {
    const tx = rt.edit();
    const cell = rt.getCell<string[]>(space, "fresh-rm", stringListSchema, tx);
    cell.removeByValue("x");
    expect(cell.get() ?? undefined).toBe(undefined);
  });

  it("elementById tolerates a schema without an items entry", () => {
    const looseListSchema = {
      type: "array",
    } satisfies JSONSchema;
    const tx = rt.edit();
    const list = rt.getCell(space, "loose-list", looseListSchema, tx);
    list.set([]);
    const element = list.elementById("k1");
    element.set({ note: "hi" });
    expect(element.get()).toEqual({ note: "hi" });
  });

  it("removeByValue with no matching element is a no-op", async () => {
    const tx0 = rt.edit();
    rt.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["a", "b"]);
    await tx0.commit();
    await rt.storageManager.synced();

    const tx = rt.edit();
    rt.getCell<string[]>(space, CAUSE, stringListSchema, tx).removeByValue("z");
    await tx.commit();
    await rt.storageManager.synced();

    expect(await readDurable(server)).toEqual(["a", "b"]);
  });

  it("addUnique and removeByValue match a keyed element by reference", () => {
    const tx = rt.edit();
    const votes = rt.getCell<Vote[]>(space, VOTES_CAUSE, voteListSchema, tx);
    votes.set([]);
    const vote = votes.elementById("alice|opt1");
    vote.set({ voterName: "alice", optionId: "opt1", voteType: "yes" });

    votes.addUnique(vote);
    // Re-adding the same keyed entity dedups to a single membership entry.
    votes.addUnique(vote);
    expect(votes.get()?.length).toBe(1);

    votes.removeByValue(vote);
    expect(votes.get()?.length ?? 0).toBe(0);
  });

  it("elementById carries `$defs` into the element schema", () => {
    const refListSchema = {
      type: "array",
      items: { $ref: "#/$defs/Item" },
      $defs: {
        Item: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      },
    } satisfies JSONSchema;
    const tx = rt.edit();
    const list = rt.getCell(space, "ref-list", refListSchema, tx);
    list.set([]);
    const element = list.elementById("k1");
    element.set({ name: "alice" });
    expect(element.get()).toEqual({ name: "alice" });
  });

  it("two addUnique calls on one list in one transaction both land", async () => {
    const tx = rt.edit();
    const cell = rt.getCell<string[]>(space, CAUSE, stringListSchema, tx);
    cell.addUnique("a");
    cell.addUnique("b");
    await tx.commit();
    await rt.storageManager.synced();

    expect([...await readDurable(server)].sort()).toEqual(["a", "b"]);
  });

  it("increment then decrement in one transaction nets no change", async () => {
    const tx0 = rt.edit();
    rt.getCell<number>(space, COUNTER_CAUSE, numberSchema, tx0).set(5);
    await tx0.commit();
    await rt.storageManager.synced();

    const tx = rt.edit();
    const cell = rt.getCell<number>(space, COUNTER_CAUSE, numberSchema, tx);
    cell.increment(1);
    cell.increment(-1);
    await tx.commit();
    await rt.storageManager.synced();

    expect(await readDurableNumber(server)).toBe(5);
  });

  it("mergeable ops on two fields of one entity both commit", async () => {
    const docSchema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        count: { type: "number" },
      },
    } satisfies JSONSchema;
    const cause = "multi-field-entity";

    const tx0 = rt.edit();
    rt.getCell(space, cause, docSchema, tx0).set({ tags: [], count: 0 });
    await tx0.commit();
    await rt.storageManager.synced();

    // Two distinct mergeable ops on the SAME entity document but different
    // paths: the read-exclusion bookkeeping groups both op paths under one
    // entity key.
    const tx = rt.edit();
    const doc = rt.getCell(space, cause, docSchema, tx);
    doc.key("tags").addUnique("x");
    doc.key("count").increment(2);
    await tx.commit();
    await rt.storageManager.synced();

    const readBack = SharedServerStorageManager.connectTo(server, {
      as: signer,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readBack,
    });
    try {
      const cell = rt2.getCell(space, cause, docSchema);
      await cell.sync();
      await cell.pull();
      expect(cell.get()).toEqual({ tags: ["x"], count: 2 });
    } finally {
      await rt2.dispose();
      await readBack.close();
    }
  });

  // A cell whose transaction is a TransactionWrapper (the wrapper Cell.sample()
  // and Cell.sink() install for child cells) routes its mergeable ops through
  // the wrapper's record* delegations to the inner transaction.
  it("mergeable ops route through a TransactionWrapper", () => {
    const inner = rt.edit();
    const wrapper = new TransactionWrapper(inner, { childCellTx: inner });

    // Each op records its intent through the wrapper's record* delegation as it
    // runs, so the optimistic local value reflects all four without a commit.
    const list = rt.getCell<string[]>(space, CAUSE, stringListSchema, wrapper);
    list.push("a");
    list.addUnique("b");
    list.removeByValue("a");
    expect(list.get()).toEqual(["b"]);

    const counter = rt.getCell<number>(
      space,
      COUNTER_CAUSE,
      numberSchema,
      wrapper,
    );
    counter.increment(3);
    expect(counter.get()).toBe(3);
  });

  // An increment that sums to zero is a no-op the op builder drops. Pairing it
  // with another change on the same entity forces the entity to commit, so the
  // builder still visits (and drops) the zero increment.
  it("a net-zero increment alongside another change is dropped", async () => {
    const docSchema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        count: { type: "number" },
      },
    } satisfies JSONSchema;
    const cause = "net-zero-increment";

    const tx0 = rt.edit();
    rt.getCell(space, cause, docSchema, tx0).set({ tags: [], count: 5 });
    await tx0.commit();
    await rt.storageManager.synced();

    const tx = rt.edit();
    const doc = rt.getCell(space, cause, docSchema, tx);
    doc.key("count").increment(1);
    doc.key("count").increment(-1);
    doc.key("tags").addUnique("x");
    await tx.commit();
    await rt.storageManager.synced();

    const readBack = SharedServerStorageManager.connectTo(server, {
      as: signer,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readBack,
    });
    try {
      const cell = rt2.getCell(space, cause, docSchema);
      await cell.sync();
      await cell.pull();
      expect(cell.get()).toEqual({ tags: ["x"], count: 5 });
    } finally {
      await rt2.dispose();
      await readBack.close();
    }
  });

  // A recorded append whose path is overwritten by a whole-value set before
  // commit is dropped: a non-array (or empty) value at the path produces no
  // tail-relative op, and the whole-value write stands.
  it("an append superseded by a non-array set is dropped", async () => {
    const cause = "append-then-scalar";
    const tx = rt.edit();
    const cell = rt.getCell<string[] | number>(space, cause, anySchema, tx);
    cell.set([]);
    cell.push("x");
    cell.set(5);
    await tx.commit();
    await rt.storageManager.synced();

    const readBack = SharedServerStorageManager.connectTo(server, {
      as: signer,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readBack,
    });
    try {
      const cell2 = rt2.getCell<number>(space, cause, anySchema);
      await cell2.sync();
      await cell2.pull();
      expect(cell2.get()).toBe(5);
    } finally {
      await rt2.dispose();
      await readBack.close();
    }
  });

  it("an append superseded by an empty-array set yields no tail op", async () => {
    const tx0 = rt.edit();
    rt.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["a"]);
    await tx0.commit();
    await rt.storageManager.synced();

    const tx = rt.edit();
    const cell = rt.getCell<string[]>(space, CAUSE, stringListSchema, tx);
    cell.push("x");
    cell.set([]);
    await tx.commit();
    await rt.storageManager.synced();

    expect(await readDurable(server)).toEqual([]);
  });

  it("two removeByValue calls in one transaction remove both", async () => {
    const tx0 = rt.edit();
    rt.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set([
      "a",
      "b",
      "c",
    ]);
    await tx0.commit();
    await rt.storageManager.synced();

    const tx = rt.edit();
    const cell = rt.getCell<string[]>(space, CAUSE, stringListSchema, tx);
    cell.removeByValue("a");
    cell.removeByValue("b");
    await tx.commit();
    await rt.storageManager.synced();

    expect(await readDurable(server)).toEqual(["c"]);
  });
});

// The home-space `spaces` list shape: an array of `{ name }` records addressed
// by name via `elementById`. Adding sets the keyed entity and add-uniques it
// (dedup by the deterministic link); removing matches that link. This mirrors
// home.tsx's addSpaceHandler / removeSpaceHandler after the keyed migration —
// object elements are stored as links, so membership merges by identity, not by
// whole-record value equality.
interface NamedEntry {
  name: string;
}

const NAMED_CAUSE = "keyed-named-list";

const namedListSchema = {
  type: "array",
  items: {
    type: "object",
    properties: { name: { type: "string" } },
  },
} satisfies JSONSchema;

async function readDurableNamed(
  server: MemoryV2Server.Server,
): Promise<NamedEntry[]> {
  const storage = SharedServerStorageManager.connectTo(server, { as: signer });
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  try {
    const cell = rt.getCell<NamedEntry[]>(space, NAMED_CAUSE, namedListSchema);
    await cell.sync();
    await cell.pull();
    return (cell.get() ?? []) as NamedEntry[];
  } finally {
    await rt.dispose();
    await storage.close();
  }
}

describe("keyed object list (home spaces shape)", () => {
  let server: MemoryV2Server.Server;
  let storage1: SharedServerStorageManager;
  let storage2: SharedServerStorageManager;

  beforeEach(() => {
    server = newSharedServer();
    storage1 = SharedServerStorageManager.connectTo(server, { as: signer });
    storage2 = SharedServerStorageManager.connectTo(server, { as: signer });
  });
  afterEach(async () => {
    await storage1?.close();
    await storage2?.close();
    await server?.close();
  });

  // Two sessions add spaces with distinct names against the same base; both
  // memberships merge rather than the second clobbering the first.
  it("two sessions add distinct names concurrently — both survive", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<NamedEntry[]>(space, NAMED_CAUSE, namedListSchema, tx0).set(
        [],
      );
      await tx0.commit();
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<NamedEntry[]>(
        space,
        NAMED_CAUSE,
        namedListSchema,
      );
      await cell2.sync();
      await cell2.pull();

      const txA = rt1.edit();
      const spacesA = rt1.getCell<NamedEntry[]>(
        space,
        NAMED_CAUSE,
        namedListSchema,
        txA,
      );
      const a = spacesA.elementById("alpha");
      a.set({ name: "alpha" });
      spacesA.addUnique(a);
      await txA.commit();
      await rt1.storageManager.synced();

      // rt2 still holds [] (has not observed "alpha").
      const txB = rt2.edit();
      const spacesB = rt2.getCell<NamedEntry[]>(
        space,
        NAMED_CAUSE,
        namedListSchema,
        txB,
      );
      const b = spacesB.elementById("beta");
      b.set({ name: "beta" });
      spacesB.addUnique(b);
      await txB.commit();
      await rt2.storageManager.synced();

      const durable = await readDurableNamed(server);
      expect(durable.map((e) => e.name).sort()).toEqual(["alpha", "beta"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  // Two sessions add the SAME name against the same base; the key derives to the
  // same entity, so add-unique dedups by link to one membership entry.
  it("two sessions add the same name concurrently — dedups to one", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      rt1.getCell<NamedEntry[]>(space, NAMED_CAUSE, namedListSchema, tx0).set(
        [],
      );
      await tx0.commit();
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<NamedEntry[]>(
        space,
        NAMED_CAUSE,
        namedListSchema,
      );
      await cell2.sync();
      await cell2.pull();

      const txA = rt1.edit();
      const spacesA = rt1.getCell<NamedEntry[]>(
        space,
        NAMED_CAUSE,
        namedListSchema,
        txA,
      );
      const a = spacesA.elementById("dup");
      a.set({ name: "dup" });
      spacesA.addUnique(a);
      await txA.commit();
      await rt1.storageManager.synced();

      const txB = rt2.edit();
      const spacesB = rt2.getCell<NamedEntry[]>(
        space,
        NAMED_CAUSE,
        namedListSchema,
        txB,
      );
      const b = spacesB.elementById("dup");
      b.set({ name: "dup" });
      spacesB.addUnique(b);
      await txB.commit();
      await rt2.storageManager.synced();

      const durable = await readDurableNamed(server);
      expect(durable.map((e) => e.name)).toEqual(["dup"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  // Two sessions remove different spaces by key concurrently; both removals land
  // instead of clobbering through a whole-list rewrite.
  it("two sessions remove distinct names concurrently — both land", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
    try {
      const tx0 = rt1.edit();
      const seed = rt1.getCell<NamedEntry[]>(
        space,
        NAMED_CAUSE,
        namedListSchema,
        tx0,
      );
      seed.set([]);
      for (const name of ["a", "b", "c"]) {
        const e = seed.elementById(name);
        e.set({ name });
        seed.addUnique(e);
      }
      await tx0.commit();
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<NamedEntry[]>(
        space,
        NAMED_CAUSE,
        namedListSchema,
      );
      await cell2.sync();
      await cell2.pull();

      const txA = rt1.edit();
      const spacesA = rt1.getCell<NamedEntry[]>(
        space,
        NAMED_CAUSE,
        namedListSchema,
        txA,
      );
      spacesA.removeByValue(spacesA.elementById("b"));
      await txA.commit();
      await rt1.storageManager.synced();

      // rt2, still holding all three, removes a different space.
      const txB = rt2.edit();
      const spacesB = rt2.getCell<NamedEntry[]>(
        space,
        NAMED_CAUSE,
        namedListSchema,
        txB,
      );
      spacesB.removeByValue(spacesB.elementById("c"));
      await txB.commit();
      await rt2.storageManager.synced();

      const durable = await readDurableNamed(server);
      expect(durable.map((e) => e.name)).toEqual(["a"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});

// The home-space `favorites` list shape: each element is a keyed entity whose
// value CONTAINS a cell reference to the favorited piece, addressed by a key
// derived from that piece's intrinsic link. This mirrors home.tsx's addFavorite
// / removeFavorite after the keyed migration — the favorite's identity is the
// piece, so keying by the piece link dedups a re-favorite and lets an unfavorite
// remove by identity without reading the whole list.
interface FavoriteLike {
  cell: unknown;
  tags: string[];
  userTags: string[];
  spaceName?: string;
}

const FAV_CAUSE = "keyed-favorites-list";

const favoriteLikeSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      cell: { type: "unknown", asCell: ["cell"] },
      tags: { type: "array", items: { type: "string" } },
      userTags: { type: "array", items: { type: "string" } },
      spaceName: { type: "string" },
    },
    required: ["cell"],
  },
} satisfies JSONSchema;

// The key a favorite is addressed by: the favorited piece's intrinsic link,
// identical in any session that references the same piece.
function favoriteKeyFor(piece: { getAsNormalizedFullLink(): unknown }): string {
  const link = piece.getAsNormalizedFullLink() as {
    space: string;
    id: string;
    path: readonly unknown[];
  };
  return JSON.stringify([link.space, link.id, link.path]);
}

describe("keyed entity holding a cell reference (home favorites shape)", () => {
  let server: MemoryV2Server.Server;
  let storage1: SharedServerStorageManager;
  let rt: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    storage1 = SharedServerStorageManager.connectTo(server, { as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
  });
  afterEach(async () => {
    await rt?.dispose();
    await storage1?.close();
    await server?.close();
  });

  it("favoriting a piece by its link dedups and removes by identity", () => {
    const tx = rt.edit();
    // The piece being favorited: any cell with a stable link.
    const piece = rt.getCell<{ title: string }>(
      space,
      "favorited-piece",
      anySchema,
      tx,
    );
    piece.set({ title: "a piece" });

    const favorites = rt.getCell<FavoriteLike[]>(
      space,
      FAV_CAUSE,
      favoriteLikeSchema,
      tx,
    );
    favorites.set([]);

    const key = favoriteKeyFor(piece);
    const entry = favorites.elementById(key);
    entry.set({ cell: piece, tags: ["x"], userTags: [], spaceName: "s" });
    favorites.addUnique(entry);
    expect(favorites.get()?.length).toBe(1);
    // The stored element carries the piece as a cell reference and the tags.
    expect(favorites.get()?.[0].cell).toBeTruthy();
    expect(favorites.get()?.[0].tags).toEqual(["x"]);

    // Re-favoriting the same piece resolves to the same key — dedups to one.
    const again = favorites.elementById(favoriteKeyFor(piece));
    again.set({ cell: piece, tags: ["x"], userTags: [], spaceName: "s" });
    favorites.addUnique(again);
    expect(favorites.get()?.length).toBe(1);

    // Unfavoriting removes the membership entry by identity.
    favorites.removeByValue(favorites.elementById(favoriteKeyFor(piece)));
    expect(favorites.get()?.length ?? 0).toBe(0);
  });

  it("favorites of two distinct pieces coexist and remove independently", () => {
    const tx = rt.edit();
    const pieceA = rt.getCell<{ title: string }>(
      space,
      "piece-a",
      anySchema,
      tx,
    );
    pieceA.set({ title: "A" });
    const pieceB = rt.getCell<{ title: string }>(
      space,
      "piece-b",
      anySchema,
      tx,
    );
    pieceB.set({ title: "B" });

    const favorites = rt.getCell<FavoriteLike[]>(
      space,
      FAV_CAUSE,
      favoriteLikeSchema,
      tx,
    );
    favorites.set([]);

    for (const [piece, tag] of [[pieceA, "a"], [pieceB, "b"]] as const) {
      const entry = favorites.elementById(favoriteKeyFor(piece));
      entry.set({ cell: piece, tags: [tag], userTags: [] });
      favorites.addUnique(entry);
    }
    expect(favorites.get()?.length).toBe(2);

    // Removing one leaves the other intact.
    favorites.removeByValue(favorites.elementById(favoriteKeyFor(pieceA)));
    const remaining = favorites.get() ?? [];
    expect(remaining.length).toBe(1);
    // The surviving favorite is pieceB's, identified by its tag.
    expect(remaining[0].tags).toEqual(["b"]);
    expect(remaining[0].cell).toBeTruthy();
  });
});
