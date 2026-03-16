import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commontools/identity";
import type { AppliedCommit } from "@commontools/memory/v2/engine";
import type { MemorySpace, URI } from "@commontools/memory/interface";
import {
  type SessionFactory,
  StorageManager as V2StorageManager,
} from "../src/storage/v2.ts";

const signer = await Identity.fromPassphrase("memory-v2-lazy-session");
const space = signer.did();
const type = "application/json" as const;

class TestStorageManager extends V2StorageManager {
  constructor(sessionFactory: SessionFactory) {
    super(
      {
        as: signer,
        address: new URL("memory://"),
      },
      sessionFactory,
    );
  }
}

const appliedCommitFor = (ids: URI[]): AppliedCommit => ({
  seq: 1,
  hash: "bafyreifakecommit" as AppliedCommit["hash"],
  branch: "main",
  facts: ids.map((id) => ({
    id,
    hash: `bafyreifake-${id}` as AppliedCommit["hash"],
    valueRef: `value:${id}`,
    parent: null,
    branch: "main",
    seq: 1,
    commitSeq: 1,
    factType: "set",
  })),
});

describe("Memory v2 lazy session creation", () => {
  it("does not create a session for open or local transaction reads and writes", async () => {
    let sessionCreates = 0;
    const storage = new TestStorageManager({
      async create(_space: MemorySpace) {
        sessionCreates += 1;
        return {
          client: { close: async () => {} } as never,
          session: {} as never,
        };
      },
    });

    storage.open(space);

    const tx = storage.edit();
    const write = tx.write({
      space,
      id: "of:memory-v2-lazy-session-open",
      type,
      path: [],
    }, {
      value: { count: 1 },
    });
    expect(write.error).toBeUndefined();

    const read = tx.read({
      space,
      id: "of:memory-v2-lazy-session-open",
      type,
      path: ["value", "count"],
    });
    expect(read.ok?.value).toBe(1);
    expect(sessionCreates).toBe(0);

    tx.abort();
    await storage.close();
    expect(sessionCreates).toBe(0);
  });

  it("creates a session lazily on the first commit", async () => {
    let sessionCreates = 0;
    let commits = 0;
    let closes = 0;
    const storage = new TestStorageManager({
      async create(_space: MemorySpace) {
        sessionCreates += 1;
        return {
          client: {
            close: async () => {
              closes += 1;
            },
          } as never,
          session: {
            transact: async (commit: { operations: { id: URI }[] }) => {
              commits += 1;
              return appliedCommitFor(commit.operations.map((op) => op.id));
            },
          } as never,
        };
      },
    });

    const tx = storage.edit();
    const id = "of:memory-v2-lazy-session-commit" as URI;
    tx.write({
      space,
      id,
      type,
      path: [],
    }, {
      value: { count: 1 },
    });
    expect(sessionCreates).toBe(0);

    const result = await tx.commit();
    expect(result).toEqual({ ok: {} });
    expect(sessionCreates).toBe(1);
    expect(commits).toBe(1);

    await storage.close();
    expect(closes).toBe(1);
  });
});
