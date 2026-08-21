import { beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { parseLink, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { getResultCellWithSourceSchema } from "../../runner/src/piece-helpers.ts";
import { renderCachedResultFields } from "../commands/piece.ts";
import { type CachedResultField, cachedResultFields } from "../lib/piece.ts";

/**
 * A pattern whose result carries each shape the classification has to tell
 * apart.
 *
 * `title` hands the argument's own cell back, so a read of it lands in the
 * argument document. `shout` is derived from it, so the runtime materializes a
 * computed cell and a read of it lands there. `loud` is derived too, and its
 * result field stores a link to a computed cell which holds a link on to the
 * map's ordinary output entity. Resolving `loud` therefore crosses cached
 * state even though it ends in live state.
 */
const PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { computed, pattern } from "commonfabric";',
      "",
      "interface In { title: string; items: string[]; }",
      "interface Out {",
      "  title: string;",
      "  shout: string;",
      "  loud: string[];",
      "}",
      "",
      "export default pattern<In, Out>(({ title, items }) => ({",
      "  title,",
      "  shout: computed(() => title.toUpperCase()),",
      "  loud: items.map((item) => item.toUpperCase()),",
      "}));",
    ].join("\n"),
  }],
};

const FIELDS = ["title", "shout", "loud"];

/** What one run of {@link PROGRAM} says about its own result fields. */
interface LivePieceReport {
  cached: CachedResultField[];
  /** The entity each field's own stored link names, before any is followed. */
  firstHop: Record<string, string>;
}

/** Builds a piece from {@link PROGRAM}, runs it, and reports on its result. */
async function runLivePiece(): Promise<LivePieceReport> {
  const signer = await Identity.fromPassphrase("piece cached result fields");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
  });
  try {
    const space = signer.did();
    const compiled = await runtime.patternManager.compilePattern(
      PROGRAM as never,
      { space },
    );
    const tx = runtime.edit();
    const rootCell = runtime.getCell(space, "cached-fields", undefined, tx);
    const root = runtime.run(
      tx,
      compiled,
      { title: "cruller", items: ["jam", "glaze"] },
      rootCell,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();
    await storageManager.synced();
    await root.pull();

    const result = getResultCellWithSourceSchema(root);
    const base = result.getAsNormalizedFullLink();
    const stored = result.getRaw({ lastNode: "top" }) as Record<
      string,
      unknown
    >;
    const firstHop: Record<string, string> = {};
    for (const name of FIELDS) {
      firstHop[name] = parseLink(stored[name] as never, base)?.id ?? base.id;
    }
    return { cached: cachedResultFields(result, FIELDS), firstHop };
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

describe("piece-cached-result-fields", () => {
  describe("cachedResultFields()", () => {
    let report: LivePieceReport;

    beforeAll(async () => {
      report = await runLivePiece();
    });

    it("returns the derived field and not the one linked into the argument", () => {
      expect(report.cached.map((field) => field.name)).toEqual([
        "shout",
        "loud",
      ]);
      expect(report.cached[0].cells[0].id.startsWith("computed:")).toBe(true);
    });

    it("returns the commit the derived field's own document last stood at", () => {
      expect(typeof report.cached[0].cells[0].derivedAtCommit).toBe("number");
    });

    it("returns a computed hop which links on to live state", () => {
      expect(report.firstHop.loud.startsWith("computed:")).toBe(true);
      expect(report.cached.find((field) => field.name === "loud")?.cells)
        .toEqual([
          expect.objectContaining({
            id: report.firstHop.loud,
            derivedAtCommit: expect.any(Number),
          }),
        ]);
    });
  });

  describe("renderCachedResultFields()", () => {
    it("returns each field's own commit beside the argument's", () => {
      const section = renderCachedResultFields(
        [
          {
            name: "adminName",
            cells: [{
              id: "computed:fid1:one",
              space: "did:key:source",
              scope: "space",
              derivedAtCommit: 182802,
            }],
          },
          {
            name: "todayDate",
            cells: [{
              id: "computed:fid1:two",
              space: "did:key:source",
              scope: "space",
              derivedAtCommit: 182785,
            }],
          },
        ],
        253299,
        "did:key:source",
      );

      expect(section).toBe(
        [
          "--- Cached Result Fields ---",
          "Each field below crosses computed state holding what its last committed",
          "derivation produced. Reading the field does not re-derive that state.",
          "  - adminName: last derived at commit 182802; Source (Inputs) stands at commit 253299",
          "  - todayDate: last derived at commit 182785; Source (Inputs) stands at commit 253299",
        ].join("\n"),
      );
    });

    it("returns `(none)` when every result field reads live state", () => {
      expect(renderCachedResultFields([], 253299, "did:key:source")).toBe(
        "--- Cached Result Fields ---\n  (none)",
      );
    });

    it("returns a field with no commit as one the replica holds none for", () => {
      const section = renderCachedResultFields(
        [{
          name: "myName",
          cells: [{
            id: "computed:fid1:three",
            space: "did:key:source",
            scope: "space",
          }],
        }],
        undefined,
        "did:key:source",
      );

      expect(section).toContain(
        "- myName: the local replica holds no commit for it",
      );
      expect(section).not.toContain("Source (Inputs)");
    });

    it("does not compare commits from different spaces", () => {
      const section = renderCachedResultFields(
        [{
          name: "profileName",
          cells: [{
            id: "computed:fid1:remote",
            space: "did:key:remote",
            scope: "space",
            derivedAtCommit: 12,
          }],
        }],
        900,
        "did:key:source",
      );

      expect(section).toContain(
        "last derived at commit 12 in space did:key:remote",
      );
      expect(section).toContain(
        "Source (Inputs) stands at commit 900 in space did:key:source",
      );
      expect(section).toContain(
        "commits from different spaces cannot be compared",
      );
    });
  });
});
