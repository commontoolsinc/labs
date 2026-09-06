/**
 * Unit tests for what `ls` finds at a place and how it writes each row back.
 *
 * Every read a listing makes is `packages/cli`'s, and every case that makes
 * one stands its own in through the deps bag, so what is under test is the
 * composing —
 * which read a position takes, what a row carries, and how a row prints — with
 * no socket, no server and no piece behind any of it. What those reads do once
 * called is not this file's subject; that a listing hands each of them the
 * connection this process holds is, and three cases pin it.
 *
 * The connection is a borrowed one throughout. A listing never opens or closes
 * one, so which arm a case stands it up through decides nothing here, and the
 * borrowed arm is the one that needs no opener behind it.
 *
 * The property the file exists for is the last group's: a name `ls` prints is
 * a name `cd` takes back to the row it was printed for. It is driven over a
 * construction rather than a hand-listed few, because the interesting names
 * are the ones nobody thinks to list — and its other half matters as much,
 * that a row it has no operand for prints no name at all.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { MemorySpace } from "@commonfabric/memory/interface";
import type { PiecesController } from "@commonfabric/piece/ops";
import { linkPathSegmentToCellPathSegment } from "@commonfabric/runner/shared";

import type { SlugSummary, SpaceConfig } from "../lib/piece.ts";
import { HeldConnection } from "../lib/shuttle/connection.ts";
import { splitLine } from "../lib/shuttle/line.ts";
import {
  type Listing,
  type ListingDeps,
  type ListingRow,
  listPlace,
  renderListing,
} from "../lib/shuttle/listing.ts";
import { CurrentPlace, type Facet, type Place } from "../lib/shuttle/place.ts";

const SPACE = "did:key:z6MkConnectedSpace" as MemorySpace;
const HANDLE = "of:fid1:abcdefghijklmnop";
const OTHER_HANDLE = "of:fid1:qrstuvwxyz012345";

const CONFIG: SpaceConfig = {
  apiUrl: "https://toolshed.example/",
  space: SPACE,
  identity: "/keys/shuttle.pkcs8",
};

/** Helper for the cases below, which fails whichever read a case reaches. */
const READS_NOTHING: ListingDeps = {
  listSpaceSlugs: () => {
    throw new Error("The slug index was read.");
  },
  listPieces: () => {
    throw new Error("The pieces were read.");
  },
  listCellKeys: () => {
    throw new Error("The cell was read.");
  },
};

/** Helper for the cases below, which stands at the space's root. */
function atSpaceRoot(): CurrentPlace {
  return new CurrentPlace(SPACE);
}

/** Helper for the cases below, which stands inside `facet`. */
function inFacet(facet: Facet): CurrentPlace {
  const place = atSpaceRoot();
  place.cd(facet);
  return place;
}

/** Helper for the cases below, which stands at a piece, at `path` inside it. */
function atPiece(...path: string[]): CurrentPlace {
  const place = atSpaceRoot();
  place.cd(`/${HANDLE}`);
  for (const segment of path) place.cd(segment);
  return place;
}

/**
 * Helper for the cases below, which is a connection over a controller nothing
 * reads. A listing hands the controller to a read and never touches it, so
 * what a case can see is which read was handed it.
 */
function heldConnection(): {
  connection: HeldConnection;
  pieces: PiecesController;
} {
  const pieces = {
    dispose: () => Promise.resolve(),
  } as unknown as PiecesController;
  return {
    connection: new HeldConnection({ kind: "borrowed", pieces }),
    pieces,
  };
}

/** Helper for the cases below, which stands `rows` in for the slug index. */
function slugIndex(rows: SlugSummary[]): ListingDeps {
  return { ...READS_NOTHING, listSpaceSlugs: () => Promise.resolve(rows) };
}

/** Helper for the cases below, which stands `rows` in for the space's pieces. */
function spacePieces(rows: { id: string; error?: string }[]): ListingDeps {
  return { ...READS_NOTHING, listPieces: () => Promise.resolve(rows) };
}

/** Helper for the cases below, which stands `keys` in for a cell's keys. */
function cellKeys(keys: string[]): ListingDeps {
  return { ...READS_NOTHING, listCellKeys: () => Promise.resolve(keys) };
}

/** Helper for the cases below, which lists `place` over `deps`. */
function list(place: CurrentPlace, deps: ListingDeps): Promise<Listing> {
  return listPlace(CONFIG, place.place, heldConnection().connection, deps);
}

describe("listing", () => {
  describe("listPlace()", () => {
    describe("a space root", () => {
      it("returns one row per facet the root lists", async () => {
        const listing = await list(atSpaceRoot(), READS_NOTHING);
        expect(listing.rows.map((row) => row.name)).toEqual([
          "slugs",
          "pieces",
        ]);
      });

      it("returns a facet row carrying the operand `cd` takes to it", async () => {
        const listing = await list(atSpaceRoot(), READS_NOTHING);
        expect(listing.rows.map((row) => row.operand)).toEqual([
          "slugs",
          "pieces",
        ]);
      });

      it("returns the facets without reading anything", async () => {
        let reads = 0;
        await list(atSpaceRoot(), {
          listSpaceSlugs: () => {
            reads++;
            return Promise.resolve([]);
          },
          listPieces: () => {
            reads++;
            return Promise.resolve([]);
          },
          listCellKeys: () => {
            reads++;
            return Promise.resolve([]);
          },
        });
        expect(reads).toBe(0);
      });

      it("returns no bound, a root listing its whole facet set", async () => {
        const listing = await list(atSpaceRoot(), READS_NOTHING);
        expect(listing.bound).toBeUndefined();
      });
    });

    describe("`slugs/`", () => {
      it("returns one row per slug the index named", async () => {
        const listing = await list(
          inFacet("slugs"),
          slugIndex([
            { slug: "board", piece: HANDLE },
            { slug: "topics", piece: OTHER_HANDLE },
          ]),
        );
        expect(listing.rows.map((row) => row.name)).toEqual([
          "board",
          "topics",
        ]);
      });

      it("returns a slug row carrying the operand `cd` takes to its piece", async () => {
        const listing = await list(
          inFacet("slugs"),
          slugIndex([{ slug: "board", piece: HANDLE }]),
        );
        expect(listing.rows[0].operand).toBe("board");
      });

      it("returns the row of a slug that resolved to nothing, carrying its error", async () => {
        const listing = await list(
          inFacet("slugs"),
          slugIndex([{ slug: "board", error: "Slug redirects to no piece." }]),
        );
        expect(listing.rows).toEqual([{
          name: "board",
          operand: "board",
          error: "Slug redirects to no piece.",
        }]);
      });

      it("returns the rows beside a slug that resolved to nothing", async () => {
        const listing = await list(
          inFacet("slugs"),
          slugIndex([
            { slug: "board", error: "Slug redirects to no piece." },
            { slug: "topics", piece: HANDLE },
          ]),
        );
        expect(listing.rows.map((row) => row.name)).toEqual([
          "board",
          "topics",
        ]);
      });

      it("returns no operand for an index name that is no slug", async () => {
        const listing = await list(
          inFacet("slugs"),
          slugIndex([{ slug: "Board", piece: HANDLE }]),
        );
        expect(listing.rows).toEqual([{ name: "Board" }]);
      });

      it("returns a bound saying the index is what was listed", async () => {
        const listing = await list(inFacet("slugs"), slugIndex([]));
        expect(listing.bound).toBe(
          "the space's slug index names these, and a slug it never recorded " +
            "still resolves",
        );
      });
    });

    describe("`pieces/`", () => {
      it("returns one row per piece", async () => {
        const listing = await list(
          inFacet("pieces"),
          spacePieces([{ id: HANDLE }, { id: OTHER_HANDLE }]),
        );
        expect(listing.rows.map((row) => row.name)).toEqual([
          HANDLE,
          OTHER_HANDLE,
        ]);
      });

      it("returns a piece row carrying the operand `cd` takes to it", async () => {
        const listing = await list(
          inFacet("pieces"),
          spacePieces([{ id: HANDLE }]),
        );
        expect(listing.rows[0].operand).toBe(HANDLE);
      });

      it("returns the row of a piece that would not load, carrying its error", async () => {
        const listing = await list(
          inFacet("pieces"),
          spacePieces([{ id: HANDLE, error: "The piece would not load." }]),
        );
        expect(listing.rows).toEqual([{
          name: HANDLE,
          operand: HANDLE,
          error: "The piece would not load.",
        }]);
      });

      it("returns no bound, a piece listing naming every piece registered", async () => {
        const listing = await list(inFacet("pieces"), spacePieces([]));
        expect(listing.bound).toBeUndefined();
      });
    });

    describe("inside a piece", () => {
      it("returns one row per key the cell has", async () => {
        const listing = await list(atPiece(), cellKeys(["title", "body"]));
        expect(listing.rows.map((row) => row.name)).toEqual(["title", "body"]);
      });

      it("returns a key row carrying the operand `cd` takes to it", async () => {
        const listing = await list(atPiece(), cellKeys(["title"]));
        expect(listing.rows[0].operand).toBe("title");
      });

      it("reads the piece the place stands on", async () => {
        // A slug stands unresolved in the place, so what a listing hands on is
        // the slug — which is what makes a name typed back off a listing reach
        // the piece it names, the read resolving it the way `--cell` does.
        const place = inFacet("slugs");
        place.cd("board");
        let piece: string | undefined;
        await list(place, {
          ...READS_NOTHING,
          listCellKeys: (config) => {
            piece = config.piece;
            return Promise.resolve([]);
          },
        });
        expect(piece).toBe("board");
      });

      it("reads at the scope the place reads through", async () => {
        const place = atPiece();
        place.cd("@session");
        let scope: string | undefined;
        await list(place, {
          ...READS_NOTHING,
          listCellKeys: (config) => {
            scope = config.pieceScope;
            return Promise.resolve([]);
          },
        });
        expect(scope).toBe("session");
      });

      it("reads at the path inside the piece the place stands at", async () => {
        let path: (string | number)[] | undefined;
        await list(atPiece("topics", "3"), {
          ...READS_NOTHING,
          listCellKeys: (config) => {
            path = config.piecePath;
            return Promise.resolve([]);
          },
        });
        expect(path).toEqual(["topics", 3]);
      });

      it("returns no bound, a cell's keys being all of them", async () => {
        const listing = await list(atPiece(), cellKeys(["title"]));
        expect(listing.bound).toBeUndefined();
      });
    });

    describe("the held connection", () => {
      // Each read takes its connection through `deps.loadPieces`, and what
      // each case reads back is what that returns: the one controller this
      // process holds, rather than one the read would have opened.

      it("hands the slug index the connection this process holds", async () => {
        const held = heldConnection();
        let loaded: PiecesController | undefined;
        await listPlace(CONFIG, inFacet("slugs").place, held.connection, {
          ...READS_NOTHING,
          listSpaceSlugs: async (config, deps) => {
            loaded = await deps?.loadPieces?.(config);
            return [];
          },
        });
        expect(loaded).toBe(held.pieces);
      });

      it("hands the piece listing the connection this process holds", async () => {
        const held = heldConnection();
        let loaded: PiecesController | undefined;
        await listPlace(CONFIG, inFacet("pieces").place, held.connection, {
          ...READS_NOTHING,
          listPieces: async (config, deps) => {
            loaded = await deps?.loadPieces?.(config);
            return [];
          },
        });
        expect(loaded).toBe(held.pieces);
      });

      it("hands the cell listing the connection this process holds", async () => {
        const held = heldConnection();
        let loaded: PiecesController | undefined;
        await listPlace(CONFIG, atPiece().place, held.connection, {
          ...READS_NOTHING,
          listCellKeys: async (config, _path, _options, deps) => {
            loaded = await deps?.loadPieces?.(config);
            return [];
          },
        });
        expect(loaded).toBe(held.pieces);
      });
    });

    describe("a read that failed outright", () => {
      it("raises what the read raised", async () => {
        await expect(list(atPiece(), READS_NOTHING)).rejects.toThrow(
          "The cell was read.",
        );
      });
    });
  });

  describe("renderListing()", () => {
    it("returns one line per row", () => {
      expect(renderListing({
        rows: [
          { name: "title", operand: "title" },
          { name: "body", operand: "body" },
        ],
      })).toBe("title\nbody");
    });

    it("returns the operand as the line, not the name", () => {
      expect(renderListing({
        rows: [{ name: "..", operand: "/@space/of:fid1:x@space/.." }],
      })).toBe("/@space/of:fid1:x@space/..");
    });

    it("returns a marker in place of a name for a row with no operand", () => {
      expect(renderListing({ rows: [{ name: "#b" }] })).toBe(
        "<no operand: '#b'>",
      );
    });

    it("returns a marker that writes no name where the name holds a line break", () => {
      expect(renderListing({ rows: [{ name: "a\nb" }] })).toBe(
        "<no operand: a name holding a line break>",
      );
    });

    it("returns a row's error with each acted-on character shown as its glyph", () => {
      // A message is read rather than typed back, so it arrives whole and
      // merely inert: nothing is dropped and nothing is described away. This
      // is the live one — an error is the fabric's text, not shuttle's.

      const line = renderListing({
        rows: [{
          name: "board",
          operand: "board",
          error: "gone\u001b[31m: \u007f and \u009b too",
        }],
      });
      expect(line).toBe("board <error: gone␛[31m: ␡ and ␦ too>");
      expect(/\p{Cc}/u.test(line)).toBe(false);
    });

    it("returns a bound with one shown the same way", () => {
      // No bound the module builds can hold one — `SLUG_INDEX_BOUND` is a
      // constant — so this case is constructed rather than found. What it
      // guards is `renderListing`'s contract, which takes any listing a caller
      // hands it, rather than the one call the module makes.

      const line = renderListing({ rows: [], bound: "412 items\u001b[31m" });
      expect(line).toBe("<412 items␛[31m>");
    });

    it("returns an error's angle brackets as they stand", () => {
      // Escaping the acted-on class is not the marker's own decision, which
      // is that brackets delimit for a reader and not for a parser. A payload
      // may hold one, and this stays true beside the escaping.

      expect(renderListing({
        rows: [{ name: "board", operand: "board", error: "<gone>" }],
      })).toBe("board <error: <gone>>");
    });

    it("returns a message holding a line break with it written as a space", () => {
      // The other rewrite, and a different decision: a break becomes a space
      // so a message stays one row, where the rest become glyphs so a message
      // cannot instruct the terminal.

      expect(renderListing({
        rows: [{ name: "board", operand: "board", error: "two\nlines" }],
      })).toBe("board <error: two lines>");
    });

    it("returns a marker that writes no name where the name holds a control character", () => {
      // The doors refuse such a name, so no operand reaches the row — and the
      // marker is then the one place left where it would still be written.
      // Writing it there would put back on the screen exactly what refusing
      // the name kept off it.

      const line = renderListing({ rows: [{ name: "ti\u001b[31mtle" }] });
      expect(line).toBe("<no operand: a name holding a control character>");
      expect(line.includes("\u001b")).toBe(false);
    });

    it("returns a row's error after its name", () => {
      expect(renderListing({
        rows: [{ name: "board", operand: "board", error: "No piece there." }],
      })).toBe("board <error: No piece there.>");
    });

    it("returns an error's line breaks written as spaces", () => {
      expect(renderListing({
        rows: [{ name: "board", operand: "board", error: "No piece.\nboard" }],
      })).toBe("board <error: No piece. board>");
    });

    it("returns a bound's line breaks written as spaces", () => {
      // Nothing reaches this through `listPlace`, whose only bound is a module
      // constant holding no break. `Listing` is a public type and this a
      // public door, so the case drives the door rather than the path, and
      // what it holds is that a bound answers to the same one-line rule an
      // error does.

      expect(renderListing({ rows: [], bound: "Two lines.\nboard" })).toBe(
        "<Two lines. board>",
      );
    });

    it("returns the bound on a line of its own, after the rows", () => {
      expect(renderListing({
        rows: [{ name: "board", operand: "board" }],
        bound: "these are the ones the index names",
      })).toBe("board\n<these are the ones the index names>");
    });
  });

  describe("naming a row back", () => {
    // The property, over a construction rather than a list: what a listing
    // prints as a name, `cd` takes back to the row it was printed for; and a
    // row it has no operand for prints no name at all, so nothing on the
    // surface invites a reader to type a string that reaches somewhere else.
    //
    // A named row's line never opens with `<`, which is what keeps a name and
    // a marker apart on one surface. `quoteToken` is the whole of that
    // mechanism and it lives a module away: `<` is one of the characters the
    // grammar reserves, so a name holding one is printed quoted and can never
    // open with it. Nothing in this module would notice if that stopped being
    // true, which is why the assertion is here and the mutation that reds it
    // is in `line.ts`.
    //
    // The property is over the front of a printed line and not over the whole
    // of it. A row that carries an error prints the name and then a marker, so
    // the two are one string for some rows and not for others; and an error is
    // text the fabric wrote, which may hold an odd quote and leave the line as
    // a whole refusing to split. What holds of every named row is that the
    // line opens with the name, that the name is one token `cd` takes back to
    // the row, and that anything after it is separated from it — which is what
    // "copied off the front" means and all it can mean.
    //
    // What varies is as load-bearing as the property. Both kinds of row a
    // listing can name vary — the piece a facet lists and the key a piece
    // holds — and each candidate is driven through the read that produces that
    // kind, so a rule that held for one kind and not the other cannot pass.
    // The marks are the characters a reading is spelled with, at each of the
    // three places within a name where one can sit, and alone.

    const MARKS = [
      " ",
      "\t",
      "\n",
      "\r",
      "\u00a0",
      "\u2028",
      "\u2029",
      "/",
      "~",
      "#",
      "@",
      "-",
      ".",
      "<",
      ">",
      "%",
      "!",
      "|",
      "'",
      '"',
      "\\",
    ];

    /**
     * Helper for the cases below, which is every awkward spelling of a name
     * whose ordinary spelling is `head` followed by `tail`.
     */
    function candidates(head: string, tail: string): string[] {
      // The digit spellings sit here rather than among the marks: what they
      // exercise is the conversion a path segment goes through, where a
      // canonical index becomes a number and everything else stays a string.
      const values = ["", "3", "0", "01", "1e21", "-1", "1.5", "..", "-"];
      for (const mark of MARKS) {
        values.push(
          mark + head + tail,
          head + tail + mark,
          head + mark + tail,
          mark,
        );
      }
      return values;
    }

    /**
     * Helper for the case below, which is what a listing reports against the
     * candidate at `index`, and nothing where it reports nothing.
     *
     * A row carrying one is the only shape where the printed line and the
     * operand are different strings, so a construction with none of them says
     * nothing about the rows the naming rule has most to say about. Two of
     * these are chosen for what they do to a line rather than for what they
     * say: one holds an odd quote, so the line as a whole does not split and
     * only its front can be copied, and one holds a line break, which would
     * open a second line with a name on it if the renderer wrote it as it
     * stands.
     *
     * The break is written as an escape, and deliberately.
     * `check-control-characters` governs a literal control codepoint below
     * `0x20` other than the newline, so a literal break passes it; and the
     * characters `MARKS` above spells — a no-break space and the Unicode line
     * and paragraph separators — sit outside that range altogether. An awkward
     * character in a fixture is written as an escape on its own account rather
     * than on a gate's.
     */
    const REPORTED = [
      undefined,
      "No piece carries that name.",
      "It's gone.",
      "Two lines.\nboard",
    ];

    /**
     * Helper for the case below, which is the place one level inside `place`
     * called `name` — the row's own cell, built from the levels a position
     * names rather than from any operand.
     */
    function childOf(place: Place, name: string): Place {
      const position = place.position;
      switch (position.kind) {
        case "root":
          return {
            ...place,
            position: { kind: "facet", space: SPACE, facet: name as Facet },
          };
        case "facet":
          return {
            ...place,
            position: { kind: "piece", space: SPACE, piece: name, path: [] },
          };
        case "piece":
          return {
            ...place,
            position: {
              ...position,
              path: [
                ...position.path,
                linkPathSegmentToCellPathSegment(name),
              ],
            },
          };
      }
    }

    it("prints a name `cd` takes back to the row, and no name for a row it has no operand for", async () => {
      let named = 0;
      let unnamed = 0;
      let reported = 0;
      let reportedWithoutOperand = 0;

      /**
       * Helper for this case, which holds the property over one row and the
       * line it printed, `standing` being a place at the row's own level.
       */
      function check(standing: CurrentPlace, row: ListingRow, line: string) {
        // Everything true of every line goes above the branch. A row's error
        // is printed whether or not the row has an operand, and this branch
        // has twice been where a dimension reached one arm and not the other:
        // the arm that returns early reads whatever someone remembered to add
        // to it. Asserting the common half first is what stops the next
        // dimension from landing on one side.
        expect(/ <error: [^\n]*>$/.test(line)).toBe(row.error !== undefined);
        if (row.error !== undefined) reported++;

        if (row.operand === undefined) {
          expect(line.startsWith("<")).toBe(true);
          unnamed++;
          if (row.error !== undefined) reportedWithoutOperand++;
          return;
        }
        expect(line.startsWith("<")).toBe(false);
        expect(line.startsWith(row.operand)).toBe(true);
        const rest = line.slice(row.operand.length);
        expect(rest === "").toBe(row.error === undefined);
        if (rest !== "") expect(rest.startsWith(" <")).toBe(true);
        const from = standing.place;
        const split = splitLine(row.operand);
        expect(split.kind).toBe("split");
        const tokens = split.kind === "split" ? split.tokens : [];
        expect(tokens.length).toBe(1);
        expect(standing.cd(tokens[0]).kind).toBe("moved");
        expect(standing.place).toEqual(childOf(from, row.name));
        named++;
      }

      const sources: {
        standing: () => CurrentPlace;
        deps: (names: string[]) => ListingDeps;
        names: string[];
      }[] = [
        {
          standing: () => inFacet("slugs"),
          deps: (names) =>
            slugIndex(names.map((slug, index) => ({
              slug,
              error: REPORTED[index % REPORTED.length],
            }))),
          names: candidates("boa", "rd"),
        },
        {
          standing: () => inFacet("pieces"),
          deps: (names) =>
            spacePieces(names.map((id, index) => ({
              id,
              error: REPORTED[index % REPORTED.length],
            }))),
          names: candidates(HANDLE.slice(0, 10), HANDLE.slice(10)),
        },
        {
          standing: () => atPiece(),
          deps: (names) => cellKeys(names),
          names: candidates("b", "c"),
        },
        {
          standing: () => atPiece("topics"),
          deps: (names) => cellKeys(names),
          names: candidates("b", "c"),
        },
      ];

      for (const source of sources) {
        const listing = await list(
          source.standing(),
          source.deps(source.names),
        );
        const lines = renderListing(listing).split("\n");
        expect(listing.rows.length).toBe(source.names.length);
        expect(lines.length).toBe(
          listing.rows.length + (listing.bound === undefined ? 0 : 1),
        );
        for (const [index, row] of listing.rows.entries()) {
          check(source.standing(), row, lines[index]);
        }
      }

      // Every outcome has to occur, or the property holds for want of anything
      // to hold over. The error clause above the branch is the strong one: it
      // holds of every line, named or not, so a row that prints an error it
      // does not carry, or drops one it does, reds it in either arm. What the
      // counts add is that both arms are reached and that an error reaches
      // each — `named` and `unnamed` for the arms, `reported` for an error
      // anywhere, and one guard per arm for an error inside it, since the
      // arms are where a row and its error are printed together and the
      // marker arm is the one this case twice computed and did not read.
      expect(named).toBeGreaterThan(0);
      expect(unnamed).toBeGreaterThan(0);
      expect(reported).toBeGreaterThan(0);
      expect(reportedWithoutOperand).toBeGreaterThan(0);
    });
  });
});
