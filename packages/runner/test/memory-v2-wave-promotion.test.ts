/** Pins local visibility when several sealed writes share one wave commit. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { type EntityDocument, resolveScopeKey } from "@commonfabric/memory/v2";
import type { URI } from "@commonfabric/memory/interface";

import type { SealedCommitVerdict } from "../src/storage/interface.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { NotificationRecorder } from "./memory-v2-test-utils.ts";

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
        Promise.withResolvers<SealedCommitVerdict>(),
      ];
      const sealed = ["a", "b", "c"].map((item, index) =>
        replica.sealNative(
          {
            operations: [{
              op: "patch",
              id,
              scope: "space",
              type: "application/json",
              patches: [{ op: "add", path: "/value/items/-", value: item }],
              value: { value: { items: ["a", "b", "c"].slice(0, index + 1) } },
            }],
          },
          undefined,
          verdicts[index].promise,
        )
      );
      try {
        const indices = order === "forward" ? [0, 1, 2] : [2, 1, 0];
        for (const index of indices) {
          verdicts[index].resolve({ committed: { seq: 10 } });
          expect(await sealed[index].settled).toEqual({ ok: {} });
          expect(replica.getDocument(id)?.value).toEqual({
            items: ["a", "b", "c"],
          });
        }
      } finally {
        for (const verdict of verdicts) {
          verdict.resolve({ withdrawn: { message: "test cleanup" } });
        }
        await manager.close();
      }
    });
  }

  it("keeps durable append order beneath speculation and a newly sealed append", async () => {
    const manager = StorageManager.emulate({ as: signer });
    const replica = manager.open(signer.did()).replica as SpaceReplica;
    replica.accessForTestingOnly.applySessionSync({
      type: "sync",
      fromSeq: 0,
      toSeq: 1,
      removes: [],
      upserts: [{ id, branch: "", seq: 1, doc: { value: { items: [] } } }],
    }, "pull");
    const verdicts: ReturnType<
      typeof Promise.withResolvers<SealedCommitVerdict>
    >[] = [];
    const items: string[] = [];
    const append = (item: string, speculative = false) => {
      const verdict = Promise.withResolvers<SealedCommitVerdict>();
      verdicts.push(verdict);
      items.push(item);
      const sealed = replica.sealNative(
        {
          operations: [{
            op: "patch",
            id,
            type: "application/json",
            patches: [{ op: "add", path: "/value/items/-", value: item }],
            value: { value: { items: [...items] } },
          }],
        },
        undefined,
        verdict.promise,
        { speculative },
      );
      return { verdict, sealed };
    };
    try {
      const first = append("a");
      const speculative = append("speculative", true);
      const second = append("b");
      expect(replica.getDocument(id)?.value).toEqual({
        items: ["a", "speculative", "b"],
      });
      second.verdict.resolve({ committed: { seq: 10 } });
      expect(await second.sealed.settled).toEqual({ ok: {} });
      expect(replica.getNonSpeculativeDocument(id)?.value).toEqual({
        items: ["a", "b"],
      });
      expect(replica.getDocument(id)?.value).toEqual({
        items: ["a", "speculative", "b"],
      });
      const third = append("c");
      expect(replica.getDocument(id)?.value).toEqual({
        items: ["a", "speculative", "b", "c"],
      });
      expect(replica.getNonSpeculativeDocument(id)?.value).toEqual({
        items: ["a", "b", "c"],
      });
      speculative.verdict.resolve({
        withdrawn: { message: "overlay retired" },
      });
      expect((await speculative.sealed.settled).error).toBeDefined();
      for (const contribution of [first, third]) {
        contribution.verdict.resolve({ committed: { seq: 10 } });
        expect(await contribution.sealed.settled).toEqual({ ok: {} });
        expect(replica.getDocument(id)?.value).toEqual({
          items: ["a", "b", "c"],
        });
      }
    } finally {
      for (const verdict of verdicts) {
        verdict.resolve({ withdrawn: { message: "test cleanup" } });
      }
      await manager.close();
    }
  });

  for (const scope of ["space", "user", "session"] as const) {
    for (const arrival of ["before", "after"] as const) {
      it(`keeps ${scope} receipt replay and notification coherent with a frame arriving ${arrival} the receipt`, async () => {
        const manager = StorageManager.emulate({ as: signer });
        const replica = manager.open(signer.did()).replica as SpaceReplica;
        const scopeKey = resolveScopeKey(scope, actor);
        const sync = (seq: number, items: string[]) =>
          replica.accessForTestingOnly.applySessionSync({
            type: "sync",
            fromSeq: 0,
            toSeq: seq,
            removes: [],
            upserts: [{
              id,
              scope,
              scopeKey,
              branch: "",
              seq,
              doc: { value: { items } },
            }],
          }, "integrate");
        const notifications = new NotificationRecorder();
        manager.subscribe(notifications);
        sync(1, []);
        const verdict = Promise.withResolvers<SealedCommitVerdict>();
        const speculativeVerdict = Promise.withResolvers<SealedCommitVerdict>();
        const append = (item: string, speculative = false) =>
          manager.open(signer.did()).replica.sealNative!(
            {
              operations: [{
                op: "patch",
                id,
                scope,
                type: "application/json",
                patches: [{ op: "add", path: "/value/items/-", value: item }],
                value: { value: { items: [item] } },
              }],
            },
            undefined,
            speculative ? speculativeVerdict.promise : verdict.promise,
            { identity: actor, speculative },
          );
        const sealed = [append("a"), append("b")];
        const speculation = append("speculative", true);
        const visible = () => replica.getDocument(id, scope, actor)?.value;
        const durable = () =>
          replica.getNonSpeculativeDocument(id, scope, actor)?.value;
        const observed: unknown[] = [];
        notifications.onNotification = (notification) => {
          if (notification.type === "integrate") observed.push(visible());
        };
        try {
          if (arrival === "before") {
            sync(10, ["a", "b"]);
            expect(visible()).toEqual({
              items: ["a", "b", "a", "b", "speculative"],
            });
            expect(durable()).toEqual({ items: ["a", "b", "a", "b"] });
            observed.length = 0;
          }
          // This callback runs after the replica's receipt callbacks but before
          // their Promise.race settlement continuations, exactly the frame gap.
          const frame = verdict.promise.then(() => {
            if (arrival === "after") sync(10, ["a", "b"]);
            expect(visible()).toEqual({ items: ["a", "b", "speculative"] });
            expect(durable()).toEqual({ items: ["a", "b"] });
            if (arrival === "before") {
              expect(observed).toContainEqual({
                items: ["a", "b", "speculative"],
              });
            } else {
              expect(observed).toHaveLength(0);
            }
          });
          verdict.resolve({ committed: { seq: 10 } });
          await frame;
          for (const contribution of sealed) {
            expect(await contribution.settled).toEqual({ ok: {} });
          }
          expect(durable()).toEqual({ items: ["a", "b"] });
          speculativeVerdict.resolve({
            withdrawn: { message: "retire", superseded: true },
          });
          expect(await speculation.settled).toEqual({ ok: {} });
          expect(visible()).toEqual({ items: ["a", "b"] });
        } finally {
          verdict.resolve({ withdrawn: { message: "test cleanup" } });
          speculativeVerdict.resolve({
            withdrawn: { message: "test cleanup" },
          });
          await manager.close();
        }
      });
    }
  }

  it("replays an accepted later wave over an older authoritative frame", async () => {
    const manager = StorageManager.emulate({ as: signer });
    const replica = manager.open(signer.did()).replica as SpaceReplica;
    const sync = (seq: number, items: string[]) =>
      replica.accessForTestingOnly.applySessionSync({
        type: "sync",
        fromSeq: 0,
        toSeq: seq,
        removes: [],
        upserts: [{ id, branch: "", seq, doc: { value: { items } } }],
      }, "integrate");
    sync(1, []);
    const verdict = Promise.withResolvers<SealedCommitVerdict>();
    const sealed = replica.sealNative(
      {
        operations: [{
          op: "patch",
          id,
          type: "application/json",
          patches: [{ op: "add", path: "/value/items/-", value: "later" }],
          value: { value: { items: ["later"] } },
        }],
      },
      undefined,
      verdict.promise,
    );
    const frame = verdict.promise.then(() => {
      sync(10, ["foreign"]);
      expect(replica.getDocument(id)?.value).toEqual({
        items: ["foreign", "later"],
      });
      expect(replica.getNonSpeculativeDocument(id)?.value).toEqual({
        items: ["foreign", "later"],
      });
    });
    try {
      verdict.resolve({ committed: { seq: 11 } });
      await frame;
      expect(await sealed.settled).toEqual({ ok: {} });
      expect(replica.getDocument(id)?.value).toEqual({
        items: ["foreign", "later"],
      });
    } finally {
      verdict.resolve({ withdrawn: { message: "test cleanup" } });
      await manager.close();
    }
  });

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
        if (arrival === "between") {
          sync(10, { value: { items: expected } });
          // The frame does not identify B's unresolved receipt. B could be
          // unrelated pending work, so its append still overlays the frame.
          expect(replica.getDocument(id)?.value).toEqual({
            items: ["a", "b", "b"],
          });
        }
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
      expect(replica.getDocument(id)?.value).toEqual({
        items: ["withdrawn", "a", "b"],
      });
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
