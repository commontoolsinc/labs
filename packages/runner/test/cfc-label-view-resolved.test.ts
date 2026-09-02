import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  cfcLabelViewForCellWithStatus,
  cfcLabelViewForResolvedCellWithStatus,
} from "../src/cfc/label-view.ts";

const signer = await Identity.fromPassphrase("runner-cfc-label-view-resolved");

/**
 * `cfcLabelViewForResolvedCellWithStatus` answers "what is the label here"
 * about a path a person selected, so it reads the doc that path RESOLVES to
 * rather than only the doc it started in. The one-hop reader it builds on
 * follows a link the path lands ON; a path that CROSSES one part way through
 * — a sqlite query result, whose rows each split into their own entity doc —
 * needs the runtime's own resolution to reach the doc holding the label.
 */
describe("cfcLabelViewForResolvedCellWithStatus", () => {
  const withRuntime = async (
    body: (runtime: Runtime, space: string) => Promise<void>,
  ) => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcDeclaredMonotonicity: "enforce",
    });
    try {
      await body(runtime, signer.did());
    } finally {
      await runtime.dispose();
    }
  };

  const commit = async (runtime: Runtime, write: (tx: never) => void) => {
    const tx = runtime.edit();
    write(tx as never);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
  };

  it("reaches a label two docs away, behind a link the path CROSSES", async () => {
    await withRuntime(async (runtime, space) => {
      // The shape a labeled query result stores: the row is its own doc and
      // carries the per-column label; the query doc only links to it.
      const row = runtime.getCell<{ secret: string }>(space, "resolved-row", {
        type: "object",
        additionalProperties: true,
        properties: {
          secret: { type: "string", ifc: { confidentiality: ["finance"] } },
        },
      });
      await commit(runtime, (tx) => {
        row.withTx(tx).set({ secret: "top secret" });
      });

      const query = runtime.getCell<never>(space, "resolved-query", undefined);
      await commit(runtime, (tx) => {
        query.withTx(tx).key("result").key(0).setRawUntyped(row.getAsLink());
      });

      const leaf = query.key("result").key(0).key("secret");
      // The one-hop reader starts in the query doc and never arrives.
      expect(cfcLabelViewForCellWithStatus(leaf).view).toBeUndefined();

      const status = cfcLabelViewForResolvedCellWithStatus(leaf);
      expect(status.readFailed).toBe(false);
      expect(status.view?.entries).toEqual([
        { path: [], label: { confidentiality: ["finance"] } },
      ]);

      // Selecting the ROW reports one entry per labeled column.
      const atRow = cfcLabelViewForResolvedCellWithStatus(
        query.key("result").key(0),
      );
      expect(atRow.view?.entries).toEqual([
        { path: ["secret"], label: { confidentiality: ["finance"] } },
      ]);
    });
  });

  it("keeps the SLOT's own label beside the target's — strictly additive", async () => {
    await withRuntime(async (runtime, space) => {
      // Two labels at one selection: one declared on the slot the path names,
      // one stored on the doc its value links to. Both belong in the answer;
      // reading only the resolved doc would drop the slot's.
      const target = runtime.getCell<string>(space, "additive-target", {
        type: "string",
        ifc: { confidentiality: ["from-target"] },
      });
      await commit(runtime, (tx) => {
        target.withTx(tx).set("linked value");
      });

      const holder = runtime.getCell<{ body: string }>(
        space,
        "additive-holder",
        {
          type: "object",
          properties: {
            body: { type: "string", ifc: { confidentiality: ["from-slot"] } },
          },
        },
      );
      await commit(runtime, (tx) => {
        holder.withTx(tx).set({ body: "placeholder" });
      });
      await commit(runtime, (tx) => {
        holder.withTx(tx).key("body").setRawUntyped(target.getAsLink());
      });

      const slot = holder.key("body");
      const atoms = (status: { view?: { entries: ReadonlyArray<unknown> } }) =>
        ((status.view?.entries ?? []) as Array<
          { label: { confidentiality?: string[] } }
        >).flatMap((entry) => entry.label.confidentiality ?? []).sort();

      // Whatever the one-hop reader finds is still in the resolved answer.
      const onehop = atoms(cfcLabelViewForCellWithStatus(slot));
      const resolved = atoms(cfcLabelViewForResolvedCellWithStatus(slot));
      for (const atom of onehop) expect(resolved).toContain(atom);
      expect(resolved).toContain("from-slot");
      expect(resolved).toContain("from-target");
    });
  });

  it("fails CLOSED when the resolution itself throws", async () => {
    await withRuntime(async (runtime, space) => {
      // A link that points at itself: the runtime's resolution runs out of
      // hops and throws. That is a FAILED read, not an absent label — a
      // reader that swallowed it would report unlabeled for a doc it never
      // managed to look at.
      const loop = runtime.getCell<never>(space, "resolved-loop", undefined);
      await commit(runtime, (tx) => {
        loop.withTx(tx).key("self").set("placeholder");
      });
      await commit(runtime, (tx) => {
        loop.withTx(tx).key("self").setRawUntyped(
          loop.key("self").getAsLink(),
        );
      });

      const status = cfcLabelViewForResolvedCellWithStatus(loop.key("self"));
      expect(status.readFailed).toBe(true);
    });
  });
});
