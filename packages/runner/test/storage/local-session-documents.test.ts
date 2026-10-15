import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  type ClientCommit,
  commitPreconditionValueHash,
} from "@commonfabric/memory/v2";

import { Runtime } from "../../src/runtime.ts";
import { getCommitLocalSeq } from "../../src/storage/commit-identity.ts";
import { restrictToLocalReads } from "../../src/storage/local-read-policy.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import {
  newSharedServer,
  TestStorageManager,
} from "../memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("local session documents");
const space = signer.did();

describe("local-session-documents", () => {
  it("reads and writes session state without opening a server connection", async () => {
    let connections = 0;
    const storage = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("http://localhost:65535"),
    }, {
      create() {
        connections++;
        throw new Error("Session state must stay local");
      },
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      experimental: { serverExecution: false },
    });
    try {
      const cell = runtime.getCell<number>(
        space,
        "count",
        undefined,
        undefined,
        "session",
      );
      await cell.sync();
      expect(cell.get()).toBeUndefined();
      const localRead = runtime.edit();
      restrictToLocalReads(localRead.tx);
      expect(cell.withTx(localRead).get()).toBeUndefined();
      localRead.abort();
      for (const value of [1, 2]) {
        const tx = runtime.edit();
        cell.withTx(tx).set(value);
        expect((await tx.commit().settled).error).toBeUndefined();
        expect(cell.get()).toBe(value);
      }
      const pin = runtime.edit();
      pin.addCommitPrecondition!(space, {
        kind: "entity-value-hash",
        id: cell.getAsNormalizedFullLink().id,
        scope: "session",
        valueHash: commitPreconditionValueHash(2),
      });
      cell.withTx(pin).set(3);
      expect((await pin.commit().settled).error).toBeUndefined();
      expect(cell.get()).toBe(3);

      const stale = runtime.edit();
      stale.addCommitPrecondition!(space, {
        kind: "entity-value-hash",
        id: cell.getAsNormalizedFullLink().id,
        scope: "session",
        valueHash: commitPreconditionValueHash(2),
      });
      cell.withTx(stale).set(4);
      expect((await stale.commit().settled).error?.name).toBe("ConflictError");
      expect(cell.get()).toBe(3);
      await storage.synced();
      expect(connections).toBe(0);
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });

  it("rolls back local session writes when the shared commit is rejected", async () => {
    const storage = EmulatedStorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      experimental: { serverExecution: false, commitPreconditions: true },
    });
    try {
      const session = runtime.getCell<number>(
        space,
        "count",
        undefined,
        undefined,
        "session",
      );
      const shared = runtime.getCell<number>(space, "count");
      const seed = runtime.edit();
      session.withTx(seed).set(1);
      expect((await seed.commit().settled).error).toBeUndefined();
      const tx = runtime.edit();
      session.withTx(tx).set(2);
      shared.withTx(tx).set(3);
      tx.addCommitPrecondition!(space, {
        kind: "origin-committed",
        originLocalSeq: 999999,
      });
      expect((await tx.commit().settled).error?.name).toBe(
        "PreconditionFailedError",
      );
      expect(session.get()).toBe(1);
      expect(shared.get()).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });

  for (const dependentScope of ["session", "mixed"]) {
    for (const rejected of [false, true]) {
      it(`settles ${dependentScope} dependants and guarded writes when a mixed commit ${rejected ? "rejects" : "succeeds"}`, async () => {
        const server = newSharedServer();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const transact = server.transact.bind(server);
        server.transact = async (...args: Parameters<typeof transact>) => {
          entered.resolve();
          await release.promise;
          return await transact(...args);
        };
        const storage = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: storage,
          experimental: { serverExecution: false, commitPreconditions: true },
        });
        try {
          const session = runtime.getCell<number>(
            space,
            "dependent-count",
            undefined,
            undefined,
            "session",
          );
          const shared = runtime.getCell<number>(space, "dependent-count");
          const seed = runtime.edit();
          session.withTx(seed).set(1);
          expect((await seed.commit().settled).error).toBeUndefined();

          const mixed = runtime.edit();
          session.withTx(mixed).set(2);
          shared.withTx(mixed).set(3);
          if (rejected) {
            mixed.addCommitPrecondition!(space, {
              kind: "origin-committed",
              originLocalSeq: 999999,
            });
          }
          const mixedCommit = mixed.commit();
          await entered.promise;
          expect(session.get()).toBe(2);

          const dependent = runtime.edit();
          const next = session.withTx(dependent);
          next.set(next.get() + 1);
          if (dependentScope === "mixed") {
            runtime.getCell<number>(
              space,
              "dependent-shared",
              undefined,
              dependent,
            )
              .set(5);
          }
          const dependentCommit = dependent.commit();
          expect(session.get()).toBe(3);
          const originLocalSeq = getCommitLocalSeq(dependent.tx, space);
          expect(originLocalSeq).toBeDefined();
          const guarded = runtime.edit();
          guarded.addCommitPrecondition!(space, {
            kind: "origin-committed",
            originLocalSeq: originLocalSeq!,
          });
          const guardedOutput = runtime.getCell<number>(space, "guarded-count");
          guardedOutput.withTx(guarded).set(4);
          const guardedCommit = guarded.commit();
          const valueGuarded = runtime.edit();
          valueGuarded.addCommitPrecondition!(space, {
            kind: "entity-value-hash",
            id: session.getAsNormalizedFullLink().id,
            scope: "session",
            valueHash: commitPreconditionValueHash(3),
          });
          const valueGuardedOutput = runtime.getCell<number>(
            space,
            "value-guarded-count",
          );
          valueGuardedOutput.withTx(valueGuarded).set(6);
          const valueGuardedCommit = valueGuarded.commit();
          release.resolve();

          expect((await mixedCommit.settled).error?.name).toBe(
            rejected ? "PreconditionFailedError" : undefined,
          );
          expect((await dependentCommit.settled).error?.name).toBe(
            rejected ? "ConflictError" : undefined,
          );
          expect((await guardedCommit.settled).error?.name).toBe(
            rejected ? "PreconditionFailedError" : undefined,
          );
          expect(session.get()).toBe(rejected ? 1 : 3);
          expect(shared.get()).toBe(rejected ? undefined : 3);
          expect(guardedOutput.get()).toBe(rejected ? undefined : 4);
          expect((await valueGuardedCommit.settled).error?.name).toBe(
            rejected ? "ConflictError" : undefined,
          );
          expect(valueGuardedOutput.get()).toBe(rejected ? undefined : 6);
        } finally {
          release.resolve();
          await runtime.dispose();
          await storage.close();
          await server.close();
        }
      });
    }
  }

  it("checks a committed session-only origin locally before writing shared state", async () => {
    const server = newSharedServer();
    const commits: ClientCommit[] = [];
    const transact = server.transact.bind(server);
    server.transact = (...args: Parameters<typeof transact>) => {
      commits.push(args[0].commit);
      return transact(...args);
    };
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      experimental: { serverExecution: false, commitPreconditions: true },
    });
    try {
      const session = runtime.getCell<number>(
        space,
        "origin",
        undefined,
        undefined,
        "session",
      );
      const shared = runtime.getCell<number>(space, "origin");
      const origin = runtime.edit();
      session.withTx(origin).set(1);
      expect((await origin.commit().settled).error).toBeUndefined();
      const originLocalSeq = getCommitLocalSeq(origin.tx, space);
      expect(originLocalSeq).toBeDefined();
      const guarded = runtime.edit();
      guarded.addCommitPrecondition!(space, {
        kind: "origin-committed",
        originLocalSeq: originLocalSeq!,
      });
      shared.withTx(guarded).set(2);
      expect((await guarded.commit().settled).error).toBeUndefined();
      expect(shared.get()).toBe(2);
      expect(commits).toHaveLength(1);
      expect(commits[0].preconditions ?? []).toEqual([]);
    } finally {
      await runtime.dispose();
      await storage.close();
      await server.close();
    }
  });

  for (const rejected of [false, true]) {
    it(`keeps a blind session write visible when an older mixed commit ${rejected ? "rejects" : "succeeds"}`, async () => {
      const server = newSharedServer();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const transact = server.transact.bind(server);
      server.transact = async (...args: Parameters<typeof transact>) => {
        entered.resolve();
        await release.promise;
        return await transact(...args);
      };
      const storage = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
        experimental: { serverExecution: false, commitPreconditions: true },
      });
      try {
        const session = runtime.getCell<number>(
          space,
          "blind-count",
          undefined,
          undefined,
          "session",
        );
        const shared = runtime.getCell<number>(space, "blind-count");
        const mixed = runtime.edit();
        session.withTx(mixed).set(1);
        shared.withTx(mixed).set(10);
        if (rejected) {
          mixed.addCommitPrecondition!(space, {
            kind: "origin-committed",
            originLocalSeq: 999999,
          });
        }
        const mixedCommit = mixed.commit();
        await entered.promise;
        const blindCommit = storage.open(space).replica.commitNative!({
          operations: [{
            op: "set",
            id: session.getAsNormalizedFullLink().id,
            type: "application/json",
            scope: "session",
            value: { value: 2 },
          }],
        });
        expect(session.get()).toBe(2);
        release.resolve();
        expect((await mixedCommit.settled).error?.name).toBe(
          rejected ? "PreconditionFailedError" : undefined,
        );
        expect((await blindCommit).error).toBeUndefined();
        expect(session.get()).toBe(2);
        expect(shared.get()).toBe(rejected ? undefined : 10);
      } finally {
        release.resolve();
        await runtime.dispose();
        await storage.close();
        await server.close();
      }
    });
  }

  for (const serverExecution of [false, true]) {
    it(`exports session documents only when server execution is enabled (${serverExecution})`, async () => {
      const server = newSharedServer();
      const commits: ClientCommit[] = [];
      const transact = server.transact.bind(server);
      server.transact = (...args: Parameters<typeof transact>) => {
        commits.push(args[0].commit);
        return transact(...args);
      };
      const storage = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
        experimental: { serverExecution },
      });
      try {
        const session = runtime.getCell<number>(
          space,
          "count",
          undefined,
          undefined,
          "session",
        );
        const shared = runtime.getCell<number>(space, "count");
        const user = runtime.getCell<number>(
          space,
          "count",
          undefined,
          undefined,
          "user",
        );
        const tx = runtime.edit();
        session.withTx(tx).set(1);
        shared.withTx(tx).set(2);
        user.withTx(tx).set(3);
        expect((await tx.commit().settled).error).toBeUndefined();
        expect(session.get()).toBe(1);
        expect(shared.get()).toBe(2);
        expect(user.get()).toBe(3);

        const next = runtime.edit();
        shared.withTx(next).set(session.withTx(next).get() + 4);
        expect((await next.commit().settled).error).toBeUndefined();
        expect(shared.get()).toBe(5);
        await storage.synced();
        const scopes = commits.flatMap((commit) =>
          commit.operations.flatMap((op) =>
            "id" in op ? [op.scope ?? "space"] : []
          )
        );
        expect(scopes).toContain("space");
        expect(scopes).toContain("user");
        expect(scopes.includes("session")).toBe(serverExecution);
        const reads = commits.flatMap((
          commit,
        ) => [...commit.reads.confirmed, ...commit.reads.pending]);
        expect(reads.some((read) => read.scope === "session")).toBe(
          serverExecution,
        );
      } finally {
        await runtime.dispose();
        await storage.close();
        await server.close();
      }
    });
  }
});
