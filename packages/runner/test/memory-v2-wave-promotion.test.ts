/** Pins local visibility when several sealed writes share one wave commit. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { EntityDocument } from "@commonfabric/memory/v2";
import type { URI } from "@commonfabric/memory/interface";

import type { SealedCommitVerdict } from "../src/storage/interface.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("wave promotion");
const id = "of:wave-promotion" as URI;
const actor = { principal: "did:key:wave-actor", sessionId: "session-a" };

describe("memory-v2-wave-promotion", () => {
  for (const scope of ["space", "user", "session"] as const) {
    it(`retains both ${scope} writes accepted at the same wave sequence`, async () => {
      const manager = StorageManager.emulate({ as: signer });
      const replica = manager.open(signer.did()).replica;
      const verdict = Promise.withResolvers<SealedCommitVerdict>();
      const first = replica.sealNative!(
        {
          operations: [{
            op: "set",
            id,
            scope,
            type: "application/json",
            value: { value: { first: true } },
          }],
        },
        undefined,
        verdict.promise,
        { identity: actor },
      );
      const second = replica.sealNative!(
        {
          operations: [{
            op: "patch",
            id,
            scope,
            type: "application/json",
            patches: [{ op: "add", path: "/value/second", value: true }],
            value: { value: { first: true, second: true } },
          }],
        },
        undefined,
        verdict.promise,
        { identity: actor },
      );
      try {
        expect(replica.getDocument(id, scope, actor)?.value).toEqual({
          first: true,
          second: true,
        });
        verdict.resolve({ committed: { seq: 10 } });
        expect(await first.settled).toEqual({ ok: {} });
        expect(await second.settled).toEqual({ ok: {} });
        expect(replica.getDocument(id, scope, actor)?.value).toEqual({
          first: true,
          second: true,
        });
      } finally {
        verdict.resolve({ withdrawn: { message: "test cleanup" } });
        await manager.close();
      }
    });
  }
  for (const order of ["forward", "reverse"] as const) {
    it(`applies appends once with ${order} verdict settlement`, async () => {
      const manager = StorageManager.emulate({ as: signer });
      const replica = manager.open(signer.did()).replica as SpaceReplica;
      replica.accessForTestingOnly.applySessionSync({
        type: "sync",
        fromSeq: 0,
        toSeq: 1,
        removes: [],
        upserts: [{ id, branch: "", seq: 1, doc: { value: { items: [] } } }],
      }, "pull");
      const verdicts = [
        Promise.withResolvers<SealedCommitVerdict>(),
        Promise.withResolvers<SealedCommitVerdict>(),
      ];
      const sealed = ["a", "b"].map((item, index) =>
        replica.sealNative(
          {
            operations: [{
              op: "patch",
              id,
              scope: "space",
              type: "application/json",
              patches: [{ op: "add", path: "/value/items/-", value: item }],
              value: { value: { items: ["a", "b"].slice(0, index + 1) } },
            }],
          },
          undefined,
          verdicts[index].promise,
        )
      );
      try {
        const indices = order === "forward" ? [0, 1] : [1, 0];
        for (const index of indices) {
          verdicts[index].resolve({ committed: { seq: 10 } });
          expect(await sealed[index].settled).toEqual({ ok: {} });
        }
        expect(replica.getDocument(id)?.value).toEqual({ items: ["a", "b"] });
      } finally {
        for (const verdict of verdicts) {
          verdict.resolve({ withdrawn: { message: "test cleanup" } });
        }
        await manager.close();
      }
    });
  }

  for (const arrival of ["before", "between", "newer"] as const) {
    it(`keeps an authoritative snapshot arriving ${arrival} the local promotions`, async () => {
      const manager = StorageManager.emulate({ as: signer });
      const replica = manager.open(signer.did()).replica as SpaceReplica;
      const sync = (seq: number, doc: EntityDocument) =>
        replica.accessForTestingOnly.applySessionSync({
          type: "sync",
          fromSeq: 0,
          toSeq: seq,
          removes: [],
          upserts: [{ id, branch: "", seq, doc }],
        }, "integrate");
      sync(1, { value: { items: [] } });
      const verdicts = [
        Promise.withResolvers<SealedCommitVerdict>(),
        Promise.withResolvers<SealedCommitVerdict>(),
      ];
      const sealed = ["a", "b"].map((item, index) =>
        replica.sealNative(
          {
            operations: [{
              op: "patch",
              id,
              type: "application/json",
              patches: [{ op: "add", path: "/value/items/-", value: item }],
              value: { value: { items: ["a", "b"].slice(0, index + 1) } },
            }],
          },
          undefined,
          verdicts[index].promise,
        )
      );
      const expected = arrival === "newer" ? ["authoritative"] : ["a", "b"];
      try {
        if (arrival !== "between") {
          sync(arrival === "newer" ? 11 : 10, { value: { items: expected } });
        }
        verdicts[0].resolve({ committed: { seq: 10 } });
        await sealed[0].settled;
        if (arrival === "between") sync(10, { value: { items: expected } });
        verdicts[1].resolve({ committed: { seq: 10 } });
        await sealed[1].settled;
        expect(replica.getDocument(id)?.value).toEqual({ items: expected });
      } finally {
        for (const verdict of verdicts) {
          verdict.resolve({ withdrawn: { message: "test cleanup" } });
        }
        await manager.close();
      }
    });
  }
  it("keeps every operation of an accepted seal when its earlier sibling is withdrawn", async () => {
    const manager = StorageManager.emulate({ as: signer });
    const replica = manager.open(signer.did()).replica as SpaceReplica;
    replica.accessForTestingOnly.applySessionSync({
      type: "sync",
      fromSeq: 0,
      toSeq: 1,
      removes: [],
      upserts: [{ id, branch: "", seq: 1, doc: { value: { items: [] } } }],
    }, "pull");
    const firstVerdict = Promise.withResolvers<SealedCommitVerdict>();
    const secondVerdict = Promise.withResolvers<SealedCommitVerdict>();
    const first = replica.sealNative(
      {
        operations: [{
          op: "patch",
          id,
          type: "application/json",
          patches: [{ op: "add", path: "/value/items/-", value: "withdrawn" }],
          value: { value: { items: ["withdrawn"] } },
        }],
      },
      undefined,
      firstVerdict.promise,
    );
    const second = replica.sealNative(
      {
        operations: ["a", "b"].map((item, index) => ({
          op: "patch",
          id,
          type: "application/json",
          patches: [{ op: "add", path: "/value/items/-", value: item }],
          value: {
            value: { items: ["withdrawn", "a", "b"].slice(0, index + 2) },
          },
        })),
      },
      undefined,
      secondVerdict.promise,
    );
    try {
      secondVerdict.resolve({ committed: { seq: 10 } });
      expect(await second.settled).toEqual({ ok: {} });
      firstVerdict.resolve({
        withdrawn: { message: "earlier contribution dropped" },
      });
      expect((await first.settled).error).toBeDefined();
      expect(replica.getDocument(id)?.value).toEqual({ items: ["a", "b"] });
    } finally {
      firstVerdict.resolve({ withdrawn: { message: "test cleanup" } });
      secondVerdict.resolve({ withdrawn: { message: "test cleanup" } });
      await manager.close();
    }
  });
});
