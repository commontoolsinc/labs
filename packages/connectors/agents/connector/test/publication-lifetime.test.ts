import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { getModernCellRepConfig } from "@commonfabric/data-model/cell-rep";
import { getCommitPreconditionsConfig } from "@commonfabric/memory/v2";
import { Runtime } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { AgentFabricTarget } from "../src/fabric.ts";
import { readStableCellGraphValue } from "../src/fabric-graph.ts";
import { sessionCause } from "../src/session-contract.ts";
import type {
  AgentDriver,
  NativeSessionSnapshot,
  SourceDescriptor,
} from "../src/types.ts";

describe("publication lifetime", () => {
  const source: SourceDescriptor = {
    id: "test:publication",
    driver: "acp",
    capabilities: {
      inventory: true,
      read: true,
      prompt: false,
      cancel: false,
      rename: false,
      setMode: false,
      setConfigOption: false,
    },
  };
  const snapshot = (id: string): NativeSessionSnapshot => ({
    summary: {
      nativeSessionId: id,
      title: id,
      cwd: null,
      createdAt: null,
      updatedAt: null,
      archived: false,
      active: false,
      raw: { id },
    },
    events: [{ id, content: "transcript" }],
    normalizedMessages: [],
    complete: true,
  });

  it("releases session runtimes before reading the next snapshot and leaves transcripts out of the host runtime", async () => {
    const identity = await Identity.fromPassphrase("publication lifetime");
    const spaceDid = identity.did();
    const server = newLoopbackServer();
    let opened = 0;
    let closed = 0;
    const createRuntime = () =>
      new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: EmulatedStorageManager.connectTo(server, {
          as: identity,
        }),
        experimental: { modernCellRep: true, commitPreconditions: false },
      });
    const runtime = createRuntime();
    const connection = {
      runtime,
      spaceDid,
      ownerDid: spaceDid,
      createPublicationRuntime: () => {
        opened++;
        const publication = createRuntime();
        const dispose = publication.dispose.bind(publication);
        publication.dispose = async () => {
          await dispose();
          closed++;
        };
        return publication;
      },
    };
    try {
      const target = await AgentFabricTarget.open(connection);
      const sessions = {
        length: 2,
        async *[Symbol.asyncIterator]() {
          expect(opened - closed).toBe(1);
          yield snapshot("one");
          expect(opened).toBe(2);
          expect(closed).toBe(1);
          expect(getModernCellRepConfig()).toBe(true);
          expect(getCommitPreconditionsConfig()).toBe(false);
          yield snapshot("two");
          expect(opened).toBe(3);
          expect(closed).toBe(2);
        },
      };
      expect(
        await target.publish([{
          source,
          sessions,
          errors: [],
          complete: true,
        }]),
      ).toBe(2);
      expect(opened).toBe(3);
      expect(closed).toBe(opened);
      for (const id of ["one", "two"]) {
        const manifest = runtime.getCell(
          spaceDid,
          sessionCause(spaceDid, spaceDid, source.id, id),
        );
        expect(
          runtime.readTx().readValueOrThrow(manifest.getAsNormalizedFullLink()),
        ).toBeUndefined();
      }
      const index = await readStableCellGraphValue(
        connection,
        target.cells.allIndex,
        undefined,
        { preserveLinkFields: new Set(["manifest"]) },
      ) as { sessions: Array<{ nativeSessionId: string }> };
      expect(index.sessions.map((entry) => entry.nativeSessionId)).toEqual([
        "one",
        "two",
      ]);
      const manifest = runtime.getCell(
        spaceDid,
        sessionCause(spaceDid, spaceDid, source.id, "one"),
      );
      expect(
        runtime.readTx().readValueOrThrow(manifest.getAsNormalizedFullLink()),
      ).toBeUndefined();
      const stored = await readStableCellGraphValue(connection, manifest) as {
        chunks: Array<{ link: { events: unknown[] } }>;
      };
      expect(stored.chunks[0].link.events).toEqual([
        { id: "one", content: "transcript" },
      ]);

      const previousOpened = opened;
      expect(
        await target.publish([{
          source,
          sessions: [snapshot("one"), snapshot("two")],
          errors: [],
          complete: true,
        }]),
      ).toBe(2);
      expect(opened).toBe(previousOpened + 1);
      expect(closed).toBe(opened);

      await expect(target.publish([{
        source,
        sessions: {
          length: 1,
          [Symbol.asyncIterator]() {
            throw new Error("spool read failed");
          },
        },
        errors: [],
        complete: true,
      }])).rejects.toThrow("spool read failed");
      expect(closed).toBe(opened);
    } finally {
      await runtime.dispose();
      await server.close();
      expect(getModernCellRepConfig()).toBe(false);
      expect(getCommitPreconditionsConfig()).toBe(true);
    }
  });

  it("publishes an independent refresh while another session read is pending", async () => {
    const identity = await Identity.fromPassphrase("queued refresh reads");
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.emulate({ as: identity }),
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const reads: string[] = [];
    const driver = {
      source,
      async readSession(id: string) {
        reads.push(id);
        if (id === "one") {
          entered.resolve();
          await release.promise;
        }
        return snapshot(id);
      },
    } as AgentDriver;
    try {
      const target = await AgentFabricTarget.open({
        runtime,
        ownerDid: identity.did(),
        spaceDid: identity.did(),
      });
      const first = target.refreshSession(driver, "one");
      await entered.promise;
      try {
        await target.refreshSession(driver, "two");
        expect(reads).toEqual(["one", "two"]);
        const index = await readStableCellGraphValue(
          target.conn,
          target.cells.allIndex,
          undefined,
          { preserveLinkFields: new Set(["manifest"]) },
        ) as { sessions: Array<{ nativeSessionId: string }> };
        expect(index.sessions.map((entry) => entry.nativeSessionId)).toEqual([
          "two",
        ]);
      } finally {
        release.resolve();
        await first;
      }
      expect(reads).toEqual(["one", "two"]);
    } finally {
      await runtime.dispose();
    }
  });
});
