import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type { AppliedCommit } from "@commonfabric/memory/v2/engine";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { type Options as V2StorageOptions } from "../src/storage/v2.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { TestStorageManager } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory-v2-lazy-session");
const space = signer.did();
const type = "application/json" as const;

class TestEmulatedStorageManager extends EmulatedStorageManager {
  static emulateWithServerFactory(
    options: Omit<V2StorageOptions, "address">,
    serverFactory: () => MemoryV2Server.Server,
  ): TestEmulatedStorageManager {
    return new this(
      {
        ...options,
        address: new URL("memory://"),
      },
      serverFactory,
    );
  }

  protected constructor(
    options: V2StorageOptions,
    serverFactory: () => MemoryV2Server.Server,
  ) {
    super(options, serverFactory);
  }
}

const appliedCommitFor = (ids: URI[]): AppliedCommit => ({
  seq: 1,
  branch: "",
  revisions: ids.map((id, index) => ({
    id,
    branch: "",
    seq: 1,
    opIndex: index,
    commitSeq: 1,
    op: "set",
  })),
});

describe("Memory v2 lazy session creation", () => {
  it("does not create a session for open or local transaction reads and writes", async () => {
    let sessionCreates = 0;
    const storage = TestStorageManager.create({
      as: signer,
      address: new URL("memory://"),
    }, {
      create(_space: MemorySpace) {
        sessionCreates += 1;
        return Promise.resolve({
          client: { close: async () => {} } as never,
          session: {} as never,
        });
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
    const storage = TestStorageManager.create({
      as: signer,
      address: new URL("memory://"),
    }, {
      create(_space: MemorySpace) {
        sessionCreates += 1;
        return Promise.resolve({
          client: {
            close: () => {
              closes += 1;
              return Promise.resolve();
            },
          } as never,
          session: {
            transact: (commit: { operations: { id: URI }[] }) => {
              commits += 1;
              return Promise.resolve(
                appliedCommitFor(commit.operations.map((op) => op.id)),
              );
            },
          } as never,
        });
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

  it("retries lazy session creation after a transient failure", async () => {
    let sessionCreates = 0;
    let commits = 0;
    let closes = 0;
    const storage = TestStorageManager.create({
      as: signer,
      address: new URL("memory://"),
    }, {
      create(_space: MemorySpace) {
        sessionCreates += 1;
        if (sessionCreates === 1) {
          return Promise.reject(new Error("temporary session failure"));
        }
        return Promise.resolve({
          client: {
            close: () => {
              closes += 1;
              return Promise.resolve();
            },
          } as never,
          session: {
            transact: (commit: { operations: { id: URI }[] }) => {
              commits += 1;
              return Promise.resolve(
                appliedCommitFor(commit.operations.map((op) => op.id)),
              );
            },
          } as never,
        });
      },
    });

    const firstTx = storage.edit();
    firstTx.write({
      space,
      id: "of:memory-v2-lazy-session-first-failure",
      type,
      path: [],
    }, {
      value: { count: 1 },
    });
    const first = await firstTx.commit();
    expect(first.error).toBeDefined();

    const secondTx = storage.edit();
    secondTx.write({
      space,
      id: "of:memory-v2-lazy-session-second-try" as URI,
      type,
      path: [],
    }, {
      value: { count: 2 },
    });
    const second = await secondTx.commit();

    expect(second).toEqual({ ok: {} });
    expect(sessionCreates).toBe(2);
    expect(commits).toBe(1);

    await storage.close();
    expect(closes).toBe(1);
  });
});

describe("Memory v2 lazy emulated server creation", () => {
  it("does not create an emulated server for local-only transaction work", async () => {
    let serverCreates = 0;
    const storage = TestEmulatedStorageManager.emulateWithServerFactory(
      { as: signer },
      () => {
        serverCreates += 1;
        return new MemoryV2Server.Server();
      },
    );

    storage.open(space);

    const tx = storage.edit();
    const write = tx.write({
      space,
      id: "of:memory-v2-lazy-emulated-server-open",
      type,
      path: [],
    }, {
      value: { count: 1 },
    });
    expect(write.error).toBeUndefined();

    const read = tx.read({
      space,
      id: "of:memory-v2-lazy-emulated-server-open",
      type,
      path: ["value", "count"],
    });
    expect(read.ok?.value).toBe(1);
    expect(serverCreates).toBe(0);

    tx.abort();
    await storage.close();
    expect(serverCreates).toBe(0);
  });

  it("creates the emulated server lazily on the first commit", async () => {
    let serverCreates = 0;
    const storage = TestEmulatedStorageManager.emulateWithServerFactory(
      { as: signer },
      () => {
        serverCreates += 1;
        return new MemoryV2Server.Server();
      },
    );

    const id = "of:memory-v2-lazy-emulated-server-commit" as URI;
    const tx = storage.edit();
    tx.write({
      space,
      id,
      type,
      path: [],
    }, {
      value: { count: 1 },
    });
    expect(serverCreates).toBe(0);

    const result = await tx.commit();
    expect(result).toEqual({ ok: {} });
    expect(serverCreates).toBe(1);

    await storage.close();
  });
});
