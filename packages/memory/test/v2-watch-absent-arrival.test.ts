/**
 * A session's watch must re-fire when a doc its query READ AS ABSENT is
 * later created — the arrival half of the ruled re-fire contract ("a
 * refusal-disposed read re-fires on a foreign writer's arrival through
 * its registered dead-end read alone", verification-coverage.md
 * OW51/OW45).
 *
 * Under server execution this is the FIRST-HYDRATION path: the server
 * materializes a piece a beat after the client learns its id, so the
 * client's first pull of a piece doc can evaluate before the birth
 * commit. The client legitimately never re-pulls — its selector tracker
 * records the pull as covered, and every later read is answered locally
 * — so the ONLY heal is this server-side re-fire. A creation flow ends
 * with a write followed by pure reads (the quiet-space tail), so a
 * watch that misses the birth starves every read of that doc for the
 * session's life while a fresh session reads it fine: the OW45 arm-B
 * starvation, store-verified zero-loss.
 *
 * Two shapes, one gate: the wake pass keys off `session.trackedIds`.
 * An absent watch ROOT enters it through its delivered seq-0 absence
 * marker; a link-HOP target the walk dead-ended on enters through the
 * graph state's MISS SET (`TrackedGraphState.missed`) — wake-reactivity
 * only, never delivered — and either way the birth commit passes the
 * touched check and `refreshTrackedGraph` delivers the real document.
 *
 * The waits await the watch view's own update stream — the delivery
 * event itself; a genuinely stuck delivery is the harness's
 * stuck-test detector's to diagnose.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import type { EntitySnapshot } from "../v2.ts";
import { Server } from "../v2/server.ts";
import { connect, loopback } from "../v2/client.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-memory-v2-watch-absent-arrival";

const harness = async (storeName: string) => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://${storeName}`),
  });
  const writerClient = await connect({ transport: loopback(server) });
  const observerClient = await connect({ transport: loopback(server) });
  const writer = await writerClient.mount(
    SPACE,
    {},
    testSessionOpenAuthFactory,
  );
  const observer = await observerClient.mount(
    SPACE,
    {},
    testSessionOpenAuthFactory,
  );
  return {
    writer,
    observer,
    async close() {
      await writerClient.close();
      await observerClient.close();
      await server.close();
    },
  };
};

describe("memory v2 watch arrival on absent docs", () => {
  it("delivers a watch's ROOT doc when it is created after the watch was registered", async () => {
    const h = await harness("memory-v2-watch-absent-root-arrival");
    try {
      // The observer watches the doc BEFORE any writer created it — the
      // first-hydration read racing the piece's birth commit.
      const view = await h.observer.watchAdd([{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:unborn-root",
            selector: { path: [], schema: false },
          }],
        },
      }]);
      // An absent root is delivered as a seq-0 absence marker — that entry
      // is what keeps the root's id in the session's tracked set, so its
      // birth can pass the wake pass's touched check at all.
      expect(view.entities.map((entity) => ({
        id: entity.id,
        seq: entity.seq,
        document: entity.document,
      }))).toEqual([{
        id: "of:doc:unborn-root",
        seq: 0,
        document: null,
      }]);

      const updates = view.subscribe();
      const pending = updates.next();

      // The doc is born — another session's commit, the way a serving
      // runtime's derived commit materializes a freshly created piece.
      await h.writer.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:unborn-root",
          value: { value: { hello: "born" } },
        }],
      });

      const update = await pending;
      expect(update.done).toBe(false);
      const entities = update.value.entities as EntitySnapshot[];
      expect(entities.map((entity) => entity.id)).toContain(
        "of:doc:unborn-root",
      );
      expect(
        entities.find((entity) => entity.id === "of:doc:unborn-root")
          ?.document,
      ).toEqual({ value: { hello: "born" } });
    } finally {
      await h.close();
    }
  });

  it("delivers a link-hop TARGET doc when it is created after the walk dead-ended on it", async () => {
    const h = await harness("memory-v2-watch-absent-hop-arrival");
    try {
      // The referrer exists and links to a doc that does not exist yet —
      // the notebook argument shape: the piece root's meta/argument link
      // resolving to a doc the walk cannot read yet.
      await h.writer.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:referrer",
          value: {
            value: {
              name: "referrer",
              primary: {
                "/": {
                  "link@1": {
                    id: "of:doc:unborn-target",
                    path: [],
                    space: SPACE,
                  },
                },
              },
            },
          },
        }],
      });

      const nodeSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          primary: { $ref: "#/$defs/node" },
        },
        $defs: {
          node: {
            type: "object",
            properties: {
              name: { type: "string" },
              primary: { $ref: "#/$defs/node" },
            },
          },
        },
      } as const satisfies JSONSchema;
      const view = await h.observer.watchAdd([{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:referrer",
            selector: { path: [], schema: nodeSchema },
          }],
        },
      }]);
      // The referrer arrives with its value; the dead-ended target is NOT
      // delivered — a miss is server-side wake-reactivity only
      // (TrackedGraphState.missed), never an absence marker on the wire,
      // so the client's view is unchanged until the document exists. (An
      // absent watch ROOT is the narrower pre-existing contract that DOES
      // deliver a seq-0 marker — the first test above pins it.)
      expect(view.entities.map((entity) => entity.id)).toEqual([
        "of:doc:referrer",
      ]);

      const updates = view.subscribe();
      const pending = updates.next();

      // The target is born; nothing ever touches the referrer again — the
      // quiet-space tail after a create-then-read flow.
      await h.writer.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:unborn-target",
          value: { value: { name: "target" } },
        }],
      });

      const update = await pending;
      expect(update.done).toBe(false);
      const entities = update.value.entities as EntitySnapshot[];
      const target = entities.find(
        (entity) => entity.id === "of:doc:unborn-target",
      );
      // The BORN document, not an absence marker: the delivered entity
      // carries the created value at a committed sequence.
      expect(target?.document).toEqual({ value: { name: "target" } });
      expect(target?.seq).toBeGreaterThanOrEqual(1);
    } finally {
      await h.close();
    }
  });

  it("keeps a dirtied-but-still-absent hop target OFF the wire and still waiting: a creation and deletion coalesced into one batch re-fires the query, the re-evaluation finds the doc absent, no absence entity is delivered, and the NEXT real creation still arrives", async () => {
    const h = await harness("memory-v2-watch-absent-hop-still-absent");
    try {
      await h.writer.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:referrer-2",
          value: {
            value: {
              name: "referrer",
              primary: {
                "/": {
                  "link@1": {
                    id: "of:doc:flicker-target",
                    path: [],
                    space: SPACE,
                  },
                },
              },
            },
          },
        }],
      });

      const nodeSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          primary: { $ref: "#/$defs/node" },
        },
        $defs: {
          node: {
            type: "object",
            properties: {
              name: { type: "string" },
              primary: { $ref: "#/$defs/node" },
            },
          },
        },
      } as const satisfies JSONSchema;
      const view = await h.observer.watchAdd([{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:referrer-2",
            selector: { path: [], schema: nodeSchema },
          }],
        },
      }]);
      expect(view.entities.map((entity) => entity.id)).toEqual([
        "of:doc:referrer-2",
      ]);

      const updates = view.subscribe();
      const pending = updates.next();

      // The target flickers: created and deleted in ONE batch, so the
      // dirty pass re-fires the query while the doc is STILL absent at
      // evaluation. The miss must stay a miss — routed back into the
      // miss set, never into the tracker whose entries reach the wire —
      // so no frame is emitted for the flicker.
      await h.writer.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: "of:doc:flicker-target",
            value: { value: { name: "flicker" } },
          },
          { op: "delete", id: "of:doc:flicker-target" },
        ],
      });

      // The REAL creation. The first update the subscription yields is
      // this one — resolving `pending`, which was registered BEFORE the
      // flicker batch, with the final value proves the flicker emitted
      // no frame of its own.
      await h.writer.transact({
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:flicker-target",
          value: { value: { name: "target" } },
        }],
      });

      const update = await pending;
      expect(update.done).toBe(false);
      const entities = update.value.entities as EntitySnapshot[];
      const target = entities.find(
        (entity) => entity.id === "of:doc:flicker-target",
      );
      expect(target?.document).toEqual({ value: { name: "target" } });
      expect(target?.seq).toBeGreaterThanOrEqual(1);
    } finally {
      await h.close();
    }
  });

  it("retires a miss when its referrer is repointed away: the target's later birth neither wakes the query nor delivers an unreachable document", async () => {
    const h = await harness("memory-v2-watch-absent-hop-repointed");
    try {
      await h.writer.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:referrer-3",
          value: {
            value: {
              name: "referrer",
              primary: {
                "/": {
                  "link@1": {
                    id: "of:doc:orphaned-target",
                    path: [],
                    space: SPACE,
                  },
                },
              },
            },
          },
        }],
      });

      const nodeSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          primary: { $ref: "#/$defs/node" },
        },
        $defs: {
          node: {
            type: "object",
            properties: {
              name: { type: "string" },
              primary: { $ref: "#/$defs/node" },
            },
          },
        },
      } as const satisfies JSONSchema;
      const view = await h.observer.watchAdd([{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:referrer-3",
            selector: { path: [], schema: nodeSchema },
          }],
        },
      }]);
      expect(view.entities.map((entity) => entity.id)).toEqual([
        "of:doc:referrer-3",
      ]);

      const updates = view.subscribe();

      // The referrer is REPOINTED away from the absent target: its
      // re-walk records no dead-end any more, so the miss retires with
      // its last attribution.
      let pending = updates.next();
      await h.writer.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:referrer-3",
          value: { value: { name: "repointed" } },
        }],
      });
      {
        const update = await pending;
        expect(update.done).toBe(false);
        const entities = update.value.entities as EntitySnapshot[];
        expect(entities.map((entity) => entity.id)).toEqual([
          "of:doc:referrer-3",
        ]);
      }

      // The former target is born. Nothing in the query links it: no
      // frame may deliver it. The next frame the subscription yields is
      // the follow-up referrer write — resolving with THAT frame, and
      // without the orphaned doc in it, proves the birth emitted
      // nothing.
      pending = updates.next();
      await h.writer.transact({
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:orphaned-target",
          value: { value: { name: "orphaned" } },
        }],
      });
      await h.writer.transact({
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:referrer-3",
          value: { value: { name: "repointed-again" } },
        }],
      });
      const update = await pending;
      expect(update.done).toBe(false);
      const entities = update.value.entities as EntitySnapshot[];
      expect(entities.map((entity) => entity.id)).toEqual([
        "of:doc:referrer-3",
      ]);
      expect(
        entities.some((entity) => entity.id === "of:doc:orphaned-target"),
      ).toBe(false);
    } finally {
      await h.close();
    }
  });
});
