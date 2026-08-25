import { isLinkRef, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { GithubFabricTarget } from "../src/fabric.ts";
import {
  type GithubFabricConnection,
  readGithubFabricCell,
  writeGithubFabricCells,
} from "../src/fabric-storage.ts";
import type { GithubPullRequest } from "../src/types.ts";

async function readIndex(
  connection: GithubFabricConnection,
  cell: Cell<unknown>,
): Promise<Record<string, unknown>> {
  return await readGithubFabricCell(connection, cell) as Record<
    string,
    unknown
  >;
}

async function readDetail(
  connection: GithubFabricConnection,
  value: unknown,
): Promise<Record<string, unknown>> {
  if (!isLinkRef(value)) throw new Error("detail is not a Fabric link");
  const cell = connection.runtime.getCellFromLink(
    linkRefPayload(value) as Parameters<Runtime["getCellFromLink"]>[0],
  );
  return await readGithubFabricCell(connection, cell) as Record<
    string,
    unknown
  >;
}

function pullRequest(): GithubPullRequest {
  return {
    id: "PR_42",
    number: 42,
    url: "https://github.com/common/labs/pull/42",
    title: "Pull request 42",
    repository: "common/labs",
    repositoryUrl: "https://github.com/common/labs",
    baseRefName: "main",
    baseRefOid: "base",
    headRefName: "feature",
    headRefOid: "head",
    headRepository: "ianh/labs",
    headRepositoryUrl: "https://github.com/ianh/labs",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeState: "CLEAN",
    reviewDecision: "APPROVED",
    checkState: "SUCCESS",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    observedAt: "2026-08-21T01:00:00.000Z",
    visibility: "visible",
    status: "green-and-can-land",
  };
}

describe("GithubFabricTarget", () => {
  describe("instance members", () => {
    describe("publish()", () => {
      it("publishes details before a complete generation index", async () => {
        const signer = await Identity.fromPassphrase("GitHub connector test");
        const storageManager = StorageManager.emulate({ as: signer });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
        });
        const connection = { runtime, spaceDid: signer.did() };
        try {
          const target = await GithubFabricTarget.open(connection, {
            host: "api.github.com",
            account: "ianh",
          });
          expect(
            await target.publish({
              viewer: "ianh",
              observedAt: "2026-08-21T01:00:00.000Z",
              pullRequests: [pullRequest()],
            }),
          ).toBe(1);

          const first = await readIndex(connection, target.cells.index);
          expect(first.generation).toBe(1);
          expect(first.lastCompleteCollectionAt).toBe(
            "2026-08-21T01:00:00.000Z",
          );
          const rows = first.pullRequests as Array<Record<string, unknown>>;
          expect(rows).toHaveLength(1);
          expect(rows[0].number).toBe(42);
          expect((await readDetail(connection, rows[0].detail)).number).toBe(
            42,
          );

          expect(
            await target.publish({
              viewer: "ianh",
              observedAt: "2026-08-21T02:00:00.000Z",
              pullRequests: [],
            }),
          ).toBe(0);
          const second = await readIndex(connection, target.cells.index);
          expect(second.generation).toBe(2);
          expect(second.pullRequests).toEqual([]);
        } finally {
          await runtime.dispose();
          await storageManager.close();
        }
      });

      it("leaves prior detail links unchanged when the index write fails", async () => {
        const signer = await Identity.fromPassphrase(
          "GitHub connector failure test",
        );
        const storageManager = StorageManager.emulate({ as: signer });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
        });
        const connection = { runtime, spaceDid: signer.did() };
        let writeCount = 0;
        let failedWrite = Number.POSITIVE_INFINITY;
        const writeGraph: typeof writeGithubFabricCells = (conn, entries) => {
          writeCount++;
          if (writeCount === failedWrite) {
            return Promise.reject(new Error("index write failed"));
          }
          return writeGithubFabricCells(conn, entries);
        };
        try {
          const target = await GithubFabricTarget.open(
            connection,
            { host: "api.github.com", account: "ianh" },
            writeGraph,
          );
          await target.publish({
            viewer: "ianh",
            observedAt: "2026-08-21T01:00:00.000Z",
            pullRequests: [pullRequest()],
          });
          failedWrite = writeCount + 2;
          await expect(target.publish({
            viewer: "ianh",
            observedAt: "2026-08-21T02:00:00.000Z",
            pullRequests: [{
              ...pullRequest(),
              title: "Changed title",
              observedAt: "2026-08-21T02:00:00.000Z",
            }],
          })).rejects.toThrow("index write failed");

          const index = await readIndex(connection, target.cells.index);
          const rows = index.pullRequests as Array<Record<string, unknown>>;
          expect(rows[0].title).toBe("Pull request 42");
          expect((await readDetail(connection, rows[0].detail)).title).toBe(
            "Pull request 42",
          );
        } finally {
          await runtime.dispose();
          await storageManager.close();
        }
      });
    });
  });
});
