import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { decode } from "@commonfabric/utils/encoding";
import { listSpaceSlugs } from "../lib/piece.ts";
import {
  listSlugsFromCommand,
  renderSlugSummaries,
} from "../commands/piece.ts";

function captureStdout(fn: () => void): string {
  let captured = "";
  const original = Deno.stdout.writeSync;
  Deno.stdout.writeSync = (data: Uint8Array): number => {
    captured += decode(data);
    return data.length;
  };
  try {
    fn();
  } finally {
    Deno.stdout.writeSync = original;
  }
  return captured;
}

const CONFIG = {
  apiUrl: "http://localhost:8000",
  identity: "/tmp/test-identity.pem",
  space: "did:key:zSlugTest",
};

describe("piece-slugs", () => {
  describe("listSpaceSlugs", () => {
    it("lists the index's names sorted, and isolates a resolution failure to its row", async () => {
      // The index cell double answers the map; everything past it is the real
      // resolution path, which this bare double cannot satisfy — so every
      // row must come back as an error row rather than the listing throwing.
      // The happy path resolves against a real runtime in
      // packages/piece/test/slug.test.ts, where resolution is real too.
      const pieces = {
        getSpace: () => CONFIG.space,
        runtime: {
          getCellFromEntityId: () => ({
            asSchema: () => ({
              pull: () =>
                Promise.resolve({ tracker: true, board: true, ghost: false }),
            }),
          }),
        },
      };

      const rows = await listSpaceSlugs(CONFIG, {
        loadPieces: () => Promise.resolve(pieces as never),
      });

      // `ghost` holds false, which is not an assignment — only `true` keys
      // are names.
      expect(rows.map((row) => row.slug)).toEqual(["board", "tracker"]);
      for (const row of rows) {
        expect(Object.hasOwn(row, "piece")).toBe(false);
        expect(typeof row.error).toBe("string");
        expect(row.error!.length).toBeGreaterThan(0);
      }
    });

    it("lists nothing for a space whose index does not exist", async () => {
      const pieces = {
        getSpace: () => CONFIG.space,
        runtime: {
          getCellFromEntityId: () => ({
            asSchema: () => ({ pull: () => Promise.resolve(undefined) }),
          }),
        },
      };

      expect(
        await listSpaceSlugs(CONFIG, {
          loadPieces: () => Promise.resolve(pieces as never),
        }),
      ).toEqual([]);
    });
  });

  describe("renderSlugSummaries", () => {
    it("renders rows as JSON with a null piece and the error carried through", () => {
      const json = captureStdout(() =>
        renderSlugSummaries([
          { slug: "board", piece: "fid1:abc" },
          {
            slug: "broken",
            error: "redirects to a document that is not a piece",
          },
        ], true)
      );
      expect(JSON.parse(json)).toEqual([
        { slug: "board", piece: "fid1:abc" },
        {
          slug: "broken",
          piece: null,
          error: "redirects to a document that is not a piece",
        },
      ]);
    });

    it("renders a SLUG/PIECE table with an error marker, and nothing when empty", () => {
      const table = captureStdout(() =>
        renderSlugSummaries([
          { slug: "board", piece: "fid1:abc" },
          { slug: "broken", error: "no longer loads" },
        ], false)
      );
      expect(table).toContain("SLUG");
      expect(table).toContain("PIECE");
      expect(table).toContain("board");
      expect(table).toContain("fid1:abc");
      expect(table).toContain("<error: no longer loads>");

      expect(captureStdout(() => renderSlugSummaries([], false))).toBe("");
    });
  });

  describe("listSlugsFromCommand", () => {
    it("hands the parsed space config to the lister and the json flag to the renderer", async () => {
      const seen: { config?: unknown; rows?: unknown; json?: boolean } = {};
      const rows = [{ slug: "board", piece: "fid1:abc" }];

      await listSlugsFromCommand(
        {
          apiUrl: CONFIG.apiUrl,
          identity: CONFIG.identity,
          space: CONFIG.space,
          json: true,
        } as never,
        {
          listSpaceSlugs: (config) => {
            seen.config = config;
            return Promise.resolve(rows);
          },
          renderSlugSummaries: (given, json) => {
            seen.rows = given;
            seen.json = json;
          },
        },
      );

      expect((seen.config as { space: string }).space).toBe(CONFIG.space);
      expect(seen.rows).toBe(rows);
      expect(seen.json).toBe(true);
    });
  });
});
