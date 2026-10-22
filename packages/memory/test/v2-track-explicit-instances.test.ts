import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { applyCommit, close, open } from "../v2/engine.ts";
import { trackGraph } from "../v2/query.ts";

const space = "did:key:z6Mk-memory-v2-track-explicit-instances";
const alice = { principal: "did:key:alice", sessionId: "session:alice" };
const bob = { principal: "did:key:bob", sessionId: "session:bob" };
const aliceKey = "user:did%3Akey%3Aalice";
const bobKey = "user:did%3Akey%3Abob";

/** A link to the space-scoped `id`: a link without a scope of its own is
 * read in the scope of the document holding it. */
const link = (id: string) => ({
  "/": { "link@1": { id, path: [], space, scope: "space" } },
});

describe("v2-track-explicit-instances", () => {
  describe("trackGraph()", () => {
    it("attributes what each instance of a root reaches to that instance", async () => {
      // One walk visits Alice's and Bob's user instances of `of:root` in
      // turn, and each instance's links are attributed to the instance
      // holding them, not to the one the walk visited first. The two are
      // walked under selectors of their own: the traversal memo keys a
      // document by its scope's name, so under one selector the second
      // instance would be answered by the first's traversal.
      const path = await Deno.makeTempFile({ suffix: ".sqlite" });
      const engine = await open({ url: toFileUrl(path) });
      try {
        applyCommit(engine, {
          ...alice,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [
              {
                op: "set",
                id: "of:root",
                scope: "user",
                value: { value: { child: link("of:x") } },
              },
              { op: "set", id: "of:x", value: { value: { name: "x" } } },
              { op: "set", id: "of:y", value: { value: { name: "y" } } },
            ],
          },
        });
        applyCommit(engine, {
          ...bob,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:root",
              scope: "user",
              value: { value: { child: link("of:y") } },
            }],
          },
        });
        const tracked = trackGraph(
          space,
          engine,
          {
            roots: [
              {
                id: "of:root",
                scope: "user",
                entityScopeKey: aliceKey,
                selector: { path: [], schema: true },
              },
              {
                id: "of:root",
                scope: "user",
                entityScopeKey: bobKey,
                selector: {
                  path: [],
                  schema: {
                    type: "object",
                    properties: { child: { type: "object" } },
                  },
                },
              },
            ],
          },
          undefined,
          alice,
        );
        const referrersOf = (id: string) =>
          [...tracked.state.trackedBy.entries()]
            .filter(([entry]) => entry.startsWith(`${space}/space/${id}\0`))
            .flatMap(([, referrers]) => [...referrers]);
        expect(referrersOf("of:x")).toEqual([`${space}/${aliceKey}/of:root`]);
        expect(referrersOf("of:y")).toEqual([`${space}/${bobKey}/of:root`]);
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });
  });
});
