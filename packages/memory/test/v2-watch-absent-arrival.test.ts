// A session's watch must re-fire when a doc its query READ AS ABSENT is
// later created — the arrival half of the ruled re-fire contract ("a
// refusal-disposed read re-fires on a foreign writer's arrival through its
// registered dead-end read alone", verification-coverage.md OW51/OW45).
//
// Under server execution this is the FIRST-HYDRATION path: the server
// materializes a piece a beat after the client learns its id, so the
// client's first pull of a piece doc can evaluate before the birth commit.
// The client legitimately never re-pulls — its selector tracker records the
// pull as covered, and every later read is answered locally — so the ONLY
// heal is this server-side re-fire. A creation flow ends with a write
// followed by pure reads (the quiet-space tail), so a watch that misses the
// birth starves every read of that doc for the session's life while a
// fresh session reads it fine: the OW45 arm-B starvation, store-verified
// zero-loss.
//
// Two shapes, one gate: the wake pass keys off `session.trackedIds`, which
// is built from DELIVERED entities only, so a doc a query touched while it
// was absent — a watch ROOT evaluated pre-birth, or a link-HOP target the
// walk dead-ended on — never enters the set, and the birth commit fails
// the touched check before `refreshTrackedGraph` (which would heal the
// root shape) is ever consulted.
//
// The nets below bound a genuinely stuck delivery (waiting-in-tests.md's
// honest-bound case): the waits are on the watch view's own update stream,
// and on the loopback transport a healthy delivery lands on the next task
// turn, so the nets add no time to a green run.

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

/** Bound a stuck delivery: yields the update, or throws naming the doc
 * whose birth never reached the watching session. */
const deliveredWithin = async <T>(
  pending: Promise<T>,
  doc: string,
  ms = 10_000,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const net = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `the birth of ${doc} never reached the watching session ` +
              `(the touched gate saw no tracked id for it)`,
          ),
        ),
      ms,
    );
  });
  try {
    return await Promise.race([pending, net]);
  } finally {
    clearTimeout(timer);
  }
};

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

      const update = await deliveredWithin(pending, "of:doc:unborn-root");
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

      const update = await deliveredWithin(pending, "of:doc:unborn-target");
      expect(update.done).toBe(false);
      const entities = update.value.entities as EntitySnapshot[];
      expect(entities.map((entity) => entity.id)).toContain(
        "of:doc:unborn-target",
      );
    } finally {
      await h.close();
    }
  });
});
