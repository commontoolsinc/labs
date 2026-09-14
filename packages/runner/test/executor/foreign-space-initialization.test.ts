import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { applyCommit, read, serverSeq } from "@commonfabric/memory/v2/engine";
import { Server } from "@commonfabric/memory/v2/server";

import { LoopbackStorageManager } from "../../src/executor/loopback-storage.ts";
import { SpaceServer } from "../../src/executor/space-server.ts";
import { emptyServingLoopStats } from "../../src/executor/stats.ts";
import { stampWaveRunContext } from "../../src/executor/wave.ts";
import { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";

const newServer = () =>
  new Server({
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen: (message) =>
      (message.invocation as { iss: string }).iss,
    sessionOpenAuth: { audience: "did:key:foreign-space-initialization" },
  });

describe("foreign-space-initialization", () => {
  for (
    const state of ["wrong-owner", "legacy", "malformed", "retracted"] as const
  ) {
    it(
      `keeps a ${state} space unauthorized after its mount settles`,
      async () => {
        const actor = await Identity.fromPassphrase("ungranted actor");
        const owner = await Identity.fromPassphrase("ungranted owner");
        const service = await Identity.fromPassphrase("ungranted service");
        const child = await Identity.fromPassphrase(
          `ungranted child ${state}`,
        );
        const server = newServer();
        const manager = LoopbackStorageManager.connect(server, {
          as: service,
          servingHomeSpace: actor.did(),
        });
        const opened = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        try {
          if (state !== "wrong-owner") {
            if (state === "legacy") {
              await server.writeDocument(
                child.did(),
                "legacy-value",
                "existing",
              );
            } else {
              await server.writeDocument(
                child.did(),
                `of:${child.did()}`,
                state === "malformed" ? {} : { [actor.did()]: "OWNER" },
              );
              if (state === "retracted") {
                const engine = await server.engineForSpace(child.did());
                applyCommit(engine, {
                  sessionId: "retract-acl",
                  commit: {
                    localSeq: 1,
                    reads: { confirmed: [], pending: [] },
                    operations: [{ op: "delete", id: `of:${child.did()}` }],
                  },
                });
              }
            }
            manager.registerSpaceIdentity(child, { owner: actor.did() });
          } else {
            manager.registerSpaceIdentity(child, {
              genesisAcl: {
                [owner.did()]: "OWNER",
                [service.did()]: "READ",
              },
            });
          }
          let gated = false;
          server.accessForTestingOnly.engineOpener = async (space, open) => {
            const engine = await open(space);
            if (space === child.did() && !gated) {
              gated = true;
              opened.resolve();
              await release.promise;
            }
            return engine;
          };
          const mounting = manager.ensureSpaceInitialized(child.did());
          await opened.promise;
          const ready = manager.waitForPendingSpaceInitialization(child.did());
          release.resolve();
          await ready;
          await mounting;
          expect(
            (await server.foreignWriteAuthorityFor(
              child.did(),
              actor.did(),
            )).granted,
          ).toBe(false);
          const acl = await server.readDocument(
            child.did(),
            `of:${child.did()}`,
          );
          expect(acl?.value).toEqual(
            state === "wrong-owner"
              ? {
                [owner.did()]: "OWNER",
                [service.did()]: "READ",
              }
              : state === "malformed"
              ? {}
              : undefined,
          );
        } finally {
          release.resolve();
          await manager.close();
          await server.close();
        }
      },
    );
  }

  it("does not open an unknown target while checking initialization readiness", async () => {
    const actor = await Identity.fromPassphrase("unknown initialization actor");
    const child = await Identity.fromPassphrase("unknown initialization child");
    const server = newServer();
    const manager = LoopbackStorageManager.connect(server, { as: actor });
    let opens = 0;
    server.accessForTestingOnly.engineOpener = (space, open) => {
      opens += 1;
      return open(space);
    };
    try {
      await manager.waitForPendingSpaceInitialization(child.did());
      expect(opens).toBe(0);
      expect(manager.openedSpaces()).toEqual([]);
      expect(await server.foreignWriteAuthorityFor(child.did(), actor.did()))
        .toEqual({ granted: true, via: "creation" });
    } finally {
      await manager.close();
      await server.close();
    }
  });

  it("does not wait for or adopt a pending mount without the space key", async () => {
    const actor = await Identity.fromPassphrase("keyless initialization actor");
    const child = await Identity.fromPassphrase("keyless initialization child");
    const server = newServer();
    const manager = LoopbackStorageManager.connect(server, { as: actor });
    const opened = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let gated = false;
    server.accessForTestingOnly.engineOpener = async (space, open) => {
      const engine = await open(space);
      if (!gated) {
        gated = true;
        opened.resolve();
        await release.promise;
      }
      return engine;
    };
    try {
      const mounting = manager.ensureSpaceInitialized(child.did());
      await opened.promise;
      await manager.waitForPendingSpaceInitialization(child.did());
      expect(
        (await server.foreignWriteAuthorityFor(child.did(), actor.did()))
          .granted,
      )
        .toBe(false);
      release.resolve();
      await mounting;
      expect(
        (await server.readDocument(child.did(), `of:${child.did()}`))?.value,
      )
        .toBeUndefined();
      expect(
        (await server.foreignWriteAuthorityFor(child.did(), actor.did()))
          .granted,
      )
        .toBe(false);
    } finally {
      release.resolve();
      await manager.close();
      await server.close();
    }
  });

  it("propagates rejection of an already-running initialization", async () => {
    const actor = await Identity.fromPassphrase(
      "rejected initialization actor",
    );
    const child = await Identity.fromPassphrase(
      "rejected initialization child",
    );
    const server = new Server({
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen: (message) => {
        const principal = (message.invocation as { iss: string }).iss;
        if (principal === child.did()) throw new Error("bootstrap refused");
        return principal;
      },
      sessionOpenAuth: { audience: "did:key:foreign-space-initialization" },
    });
    const manager = LoopbackStorageManager.connect(server, { as: actor });
    manager.registerSpaceIdentity(child, { owner: actor.did() });
    const opened = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let gated = false;
    server.accessForTestingOnly.engineOpener = async (space, open) => {
      const engine = await open(space);
      if (!gated) {
        gated = true;
        opened.resolve();
        await release.promise;
      }
      return engine;
    };
    try {
      const mounting = manager.ensureSpaceInitialized(child.did()).catch((
        error,
      ) => error);
      await opened.promise;
      const ready = manager.waitForPendingSpaceInitialization(child.did())
        .catch((error) => error);
      release.resolve();
      expect(await ready).toBeInstanceOf(Error);
      expect((await ready).message).toContain("bootstrap refused");
      expect(await mounting).toBeInstanceOf(Error);
      expect(
        (await server.foreignWriteAuthorityFor(child.did(), actor.did()))
          .granted,
      )
        .toBe(false);
      expect(
        (await server.readDocument(child.did(), `of:${child.did()}`))?.value,
      )
        .toBeUndefined();
    } finally {
      release.resolve();
      await manager.close();
      await server.close();
    }
  });

  for (const mode of ["off", "persist"] as const) {
    it(`waits for a known bootstrap before authorizing a served write with flow ${mode}`, async () => {
      const actor = await Identity.fromPassphrase("initialization actor");
      const service = await Identity.fromPassphrase("initialization service");
      const child = await Identity.fromPassphrase(
        `initialization child ${mode}`,
      );
      const server = newServer();
      const client = LoopbackStorageManager.connect(server, { as: actor });
      await client.ensureSpaceInitialized(actor.did());
      const manager = LoopbackStorageManager.connect(server, {
        as: service,
        servingHomeSpace: actor.did(),
      });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager: manager,
        cfcFlowLabels: mode,
        servingPosture: true,
        experimental: { serverExecution: true },
      });
      const engine = await server.engineForSpace(actor.did());
      const serving = new SpaceServer({
        space: actor.did(),
        server,
        engine,
        serviceIdentity: service.did(),
        createRuntime: () =>
          Promise.resolve({
            runtime,
            dispose: async () => {
              await runtime.dispose();
              await manager.close();
            },
          }),
        localSeqRef: { value: 0 },
        stats: emptyServingLoopStats(),
        ensureSpaceRoots: false,
      });
      const opened = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let gated = false;
      try {
        expect(await serving.activate()).toBe(true);
        manager.registerSpaceIdentity(child, { owner: actor.did() });
        expect(await server.foreignWriteAuthorityFor(child.did(), actor.did()))
          .toEqual({ granted: true, via: "creation" });
        server.accessForTestingOnly.engineOpener = async (space, open) => {
          const openedEngine = await open(space);
          if (space === child.did() && !gated) {
            gated = true;
            opened.resolve();
            await release.promise;
          }
          return openedEngine;
        };
        const target = runtime.getCell(child.did(), "child value", undefined);
        const loading = target.sync();
        await opened.promise;
        expect(
          (await server.foreignWriteAuthorityFor(
            child.did(),
            actor.did(),
          )).granted,
        ).toBe(false);

        // Release the delayed session only once accumulation reaches either
        // its initialization barrier or the authoritative grant probe.
        const accumulation = Promise.withResolvers<void>();
        const readiness = manager as LoopbackStorageManager & {
          waitForPendingSpaceInitialization?: (
            space: MemorySpace,
          ) => Promise<void>;
        };
        const wait = readiness.waitForPendingSpaceInitialization?.bind(manager);
        if (wait) {
          readiness.waitForPendingSpaceInitialization = (space) => {
            accumulation.resolve();
            return wait(space);
          };
        }
        const grant = server.foreignWriteAuthorityFor.bind(server);
        server.foreignWriteAuthorityFor = (space, principal) => {
          const verdict = grant(space, principal);
          accumulation.resolve();
          return verdict;
        };
        const tx = runtime.edit();
        stampWaveRunContext(tx, {
          actionId: "initialize-child",
          kind: "event-handler",
          eventId: "initialize-child-event",
          acting: { user: actor.did(), session: "actor-session" },
          capabilityRef: "event-consequence:initialize-child-event",
        });
        tx.enableMultiSpaceWrites?.([child.did(), actor.did()]);
        target.withTx(tx).set("created value");
        const home = runtime.getCell(
          actor.did(),
          "home consequence",
          undefined,
        );
        home.withTx(tx).set("child created");
        const committing = tx.commit();
        await accumulation.promise;
        release.resolve();
        await loading;
        expect((await committing).error).toBeUndefined();
        await manager.synced();
        const childEngine = await server.engineForSpace(child.did());
        expect(serverSeq(childEngine)).toBeGreaterThanOrEqual(2);
        expect(read(engine, { id: home.getAsNormalizedFullLink().id })?.value)
          .toBe("child created");
        expect(read(childEngine, { id: `of:${child.did()}` })?.value).toEqual({
          [actor.did()]: "OWNER",
          "*": "WRITE",
        });
        expect(
          read(childEngine, {
            id: target.getAsNormalizedFullLink().id,
          })?.value,
        ).toBe("created value");
      } finally {
        release.resolve();
        await serving.park("test complete");
        await serving.whenParked;
        await client.close();
        await server.close();
      }
    });
  }
});
