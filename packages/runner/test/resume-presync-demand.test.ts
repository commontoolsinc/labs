import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { documentBoundedResumeCell } from "../src/runner.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import type { JSONSchema } from "@commonfabric/api";
import { ContextualFlowControl } from "../src/cfc.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("resume presync demand");
const space = signer.did();

// A pattern whose resume wave carries both demand kinds. The lift mints a
// derived cell per element — the topics board's pivot-table shape, whose
// one derived cell owned every trivially-permissive selector the census
// found — and the declared argument and result schemas put shaped reads on
// the same wave.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { lift, pattern, Writable } from 'commonfabric';",
      "interface Row { anchor: unknown; doubled: number }",
      "const rows = lift(({ items }: { items: { n: number }[] }): Row[] => {",
      "  const out: unknown[] = [];",
      "  for (const item of items) {",
      "    if (!item) continue;",
      "    out.push(Writable.for<Row>(item).set({ anchor: item, doubled: item.n * 2 }));",
      "  }",
      "  return out as Row[];",
      "});",
      "export default pattern<{ items: { n: number }[] }, { rows: Row[] }>(",
      "  ({ items }) => {",
      "    return { rows: rows({ items }) };",
      "  },",
      ");",
    ].join("\n"),
  }],
};

describe("resume-presync-demand", () => {
  // A sync honoring a trivially-permissive schema asks the server for the
  // cell's whole reachable graph. The two sites here exist for LOCALITY —
  // having a document present before something writes or reads it — so each
  // must ask for the document, never the closure. The spy records the schema
  // every cell sync actually carries; the assertions are on what was asked,
  // which is what decides the server's walk and the wire.
  let server: ReturnType<typeof newSharedServer>;
  let sm: EmulatedStorageManager;
  let runtime: Runtime;
  let syncedSchemas: (JSONSchema | undefined)[];

  beforeEach(() => {
    server = newSharedServer();
    sm = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    syncedSchemas = [];
    const original = sm.syncCell.bind(sm);
    sm.syncCell = ((cell, options) => {
      syncedSchemas.push(cell.getAsNormalizedFullLink().schema);
      return original(cell, options);
    }) as typeof sm.syncCell;
  });

  afterEach(async () => {
    await runtime.dispose();
    await sm.close();
    await server.close();
  });

  it("kicks a document sync for a meta write, never the cell's open schema", async () => {
    const cell = runtime.getCell(space, "meta-write-target", true);
    const tx = runtime.edit();
    cell.withTx(tx).setMetaRaw("slug", "kick", rawMetaWriteAuthorization);
    tx.abort("inspection only");
    // The kick is deliberately unawaited in production; the test drains it
    // so the pull is not still in flight when teardown closes the replica.
    await sm.synced();

    // The kick fired for the document alone: the open schema the cell
    // carries never reaches a sync.
    expect(syncedSchemas).toContain(false);
    expect(syncedSchemas).not.toContain(true);
  });

  it("kicks one document sync for repeated meta writes on one cell", async () => {
    const cell = runtime.getCell(space, "meta-write-once", true);
    const tx = runtime.edit();
    const bound = cell.withTx(tx);
    bound.setMetaRaw("slug", "first", rawMetaWriteAuthorization);
    bound.setMetaRaw("slug", "second", rawMetaWriteAuthorization);
    tx.abort("inspection only");
    // Same drain as above: the unawaited kick must settle before teardown.
    await sm.synced();

    expect(syncedSchemas.filter((schema) => schema === false).length).toBe(1);
  });

  it("derives from a linked document's real value under a document-bounded warm", async () => {
    // The residual a document-bounded pre-sync accepts: a run may read a
    // document the pre-sync did not warm. The commit machinery owns
    // correctness there — a genuinely cold read of an existing document
    // enters the commit basis at sequence zero and the engine rejects the
    // commit, which compile-cache-writeback-conflict.test.ts pins on a
    // cold replica end to end. This test pins the outcome from this side:
    // with only the holder warmed as a document, the committed derivation
    // is over the target's real value.
    const otherSm = EmulatedStorageManager.connectTo(server, { as: signer });
    const otherRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: otherSm,
    });
    try {
      // Another client authors a target document and a holder whose value
      // links to it, settled server-side before this replica looks.
      const authorTx = otherRuntime.edit();
      const target = otherRuntime.getCell<{ value: number }>(
        space,
        "unwarmed-link-target",
        undefined,
        authorTx,
      );
      target.set({ value: 42 });
      otherRuntime.getCell<{ value: number }>(
        space,
        "unwarmed-link-holder",
        undefined,
        authorTx,
      ).set(target);
      await authorTx.commit();
      await otherSm.synced();

      // This replica warms the holder as a document only — what the clamped
      // pre-sync provides — so the link target is genuinely cold.
      const holder = runtime.getCell<{ value: number }>(
        space,
        "unwarmed-link-holder",
      );
      await holder.asSchema(false).sync();

      let runs = 0;
      const result = await runtime.editWithRetry((tx) => {
        runs++;
        // The holder is local (the document-bounded sync above); the target
        // its value links to is not, and this read observes that absence.
        const seen = runtime.getCell<{ value: number }>(
          space,
          "unwarmed-link-target",
          undefined,
          tx,
        ).get()?.value;
        runtime.getCell<{ doubled: number }>(
          space,
          "derived-output",
          undefined,
          tx,
        ).set({ doubled: (seen ?? 0) * 2 });
      });

      expect(result.error).toBeUndefined();
      expect(runs).toBeGreaterThan(0);
      // The committed derivation is over the target's real value, not the
      // absence the first run observed.
      const committed = runtime.getCell<{ doubled: number }>(
        space,
        "derived-output",
      );
      await committed.sync();
      expect(committed.get()).toEqual({ doubled: 84 });
    } finally {
      await otherRuntime.dispose();
      await otherSm.close();
    }
  });

  it("resumes trivially-permissive cells as documents and shaped cells as declared", async () => {
    // Author a running pattern on a sibling replica, so this replica's
    // start() is a genuine cold resume through the pre-sync cell wave —
    // the second production site, in runner.ts.
    const otherSm = EmulatedStorageManager.connectTo(server, { as: signer });
    const otherRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: otherSm,
    });
    try {
      const compiled = await otherRuntime.patternManager.compilePattern(
        PROGRAM,
        { space },
      );
      const authorTx = otherRuntime.edit();
      const authored = otherRuntime.getCell<Record<string, unknown>>(
        space,
        "resume-wave-target",
        compiled.resultSchema,
        authorTx,
      );
      otherRuntime.run(authorTx, compiled, {
        items: [{ n: 1 }, { n: 2 }, { n: 3 }],
      }, authored);
      await authorTx.commit();
      await authored.pull();
      await otherRuntime.settled();
      await otherRuntime.patternManager.flushCompileCacheWrites();
      await otherSm.synced();
    } finally {
      await otherRuntime.dispose({ closeStorage: false });
    }

    const resumed = await runtime.patternManager.compilePattern(PROGRAM, {
      space,
    });
    const tx = runtime.edit();
    const rc = runtime.getCell<Record<string, unknown>>(
      space,
      "resume-wave-target",
      resumed.resultSchema,
      tx,
    );
    await tx.commit();

    // Only the resume's own syncs are under judgment.
    syncedSchemas.length = 0;
    await runtime.start(rc);
    await runtime.idle();

    // The guard the clamp holds: no sync the resume issues carries a
    // trivially-permissive schema. Current authoring stamps declared
    // schemas on every link, so nothing here rides the clamp itself — the
    // unit case below pins that decision — and this pins the wave's whole
    // demand staying bounded if some authoring path starts writing wide
    // links again.
    const trivial = syncedSchemas.filter((schema) =>
      schema !== undefined && schema !== false &&
      ContextualFlowControl.isTrueSchema(schema)
    );
    expect(trivial).toEqual([]);
    // And the declared reads genuinely happened and kept their shapes.
    expect(
      syncedSchemas.some((schema) =>
        typeof schema === "object" && schema !== null &&
        !ContextualFlowControl.isTrueSchema(schema)
      ),
    ).toBe(true);
  });

  it("bounds a resume cell to its document exactly when its schema is trivially permissive", () => {
    // The wave's per-cell decision, on the seam the wave maps every cell
    // through. A trivially-permissive link is vintage data — deployed
    // pieces wired by older writers — which the current authoring stack
    // cannot be made to produce, so the decision is pinned here directly:
    // `true` and `{}` are sent as the document, a shaped or undeclared
    // cell keeps the sync its link declares.
    const open = runtime.getCell(space, "clamp-open", true);
    expect(documentBoundedResumeCell(open).getAsNormalizedFullLink().schema)
      .toBe(false);

    const empty = runtime.getCell(space, "clamp-empty", {});
    expect(documentBoundedResumeCell(empty).getAsNormalizedFullLink().schema)
      .toBe(false);

    const shaped = runtime.getCell(
      space,
      "clamp-shaped",
      {
        type: "object",
        properties: { n: { type: "number" } },
      } as const,
    );
    expect(documentBoundedResumeCell(shaped).getAsNormalizedFullLink().schema)
      .toEqual({
        type: "object",
        properties: { n: { type: "number" } },
      });

    const undeclared = runtime.getCell(space, "clamp-undeclared");
    expect(
      documentBoundedResumeCell(undeclared).getAsNormalizedFullLink().schema,
    ).toBe(undefined);
  });
});
