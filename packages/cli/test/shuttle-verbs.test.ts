/**
 * Unit tests for the verbs a line names and the dispatch that picks one.
 *
 * Every read a verb makes is `packages/cli`'s, and every case stands its own
 * in through the deps bag, so what is under test is the composing — which read
 * a verb reaches, what it is handed, and what comes back as an outcome — with
 * no socket, no server and no piece behind any of it. One case is the
 * exception and drives the real derivation: which space a name denotes is a
 * fact two callers have to agree about, so that case asks both.
 *
 * The connection is a borrowed one in every case but one. No verb opens or
 * closes one, so which arm a case stands it up through decides nothing here,
 * and the borrowed arm is the one that needs no opener behind it. The
 * exception is `where` over a connection that will not open, which is the one
 * question the arm decides: the borrowed arm has a controller already, so only
 * an owned one can be asked what it answers when the opening fails.
 *
 * Two properties the file exists for run through it. A read never moves the
 * place, and a move never happens twice, so each of the two verbs that resolve
 * an operand is asked what it left behind as well as what it returned. And
 * nothing here writes: the dispatch hands its outcome back, so a prompt drawing
 * its own screen is never written over from underneath.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { MemorySpace } from "@commonfabric/memory/interface";
import { SlugResolutionError } from "@commonfabric/piece";
import type { PiecesController } from "@commonfabric/piece/ops";

import { LINK_MARKER_KEY } from "../lib/cell-selection.ts";
import type {
  GetCellValueOptions,
  PieceConfig,
  SpaceConfig,
} from "../lib/piece.ts";
import { HeldConnection } from "../lib/shuttle/connection.ts";
import { CurrentPlace, operandForChild } from "../lib/shuttle/place.ts";
import { moved } from "./shuttle-place-helpers.ts";
import {
  type Outcome,
  runLine,
  type Shuttle,
  type VerbDeps,
} from "../lib/shuttle/verbs.ts";
import type { WishReadConfig } from "../lib/wish.ts";

const SPACE = "did:key:z6MkConnectedSpace" as MemorySpace;
const OTHER_SPACE = "did:key:z6MkHomeSpace" as MemorySpace;
const HANDLE = "of:fid1:abcdefghijklmnop";

/** The handle the space's index points the slug `board` at. */
const BOARD = "of:fid1:qrstuvwxyz012345";

const CONFIG: SpaceConfig = {
  apiUrl: "https://toolshed.example/",
  space: SPACE,
  identity: "/keys/shuttle.pkcs8",
};

/** The space name every shuttle here is opened under unless a case says so. */
const SPACE_NAME = "board";

/**
 * Helper for the cases below, which is a controller that answers for the space
 * it was opened over and nothing else. `name` is what a session opened by name
 * recorded, and its absence is what one opened by a DID recorded instead;
 * `space` is the DID that session settled on, which every case but one leaves
 * agreeing with the place.
 *
 * `name` takes no default, because an explicit `undefined` runs one — and the
 * arm with no name is the one a default would quietly hide.
 */
function controller(
  name: string | undefined,
  space: MemorySpace = SPACE,
): PiecesController {
  return {
    dispose: () => Promise.resolve(),
    getSpace: () => space,
    getSpaceName: () => name,
    entityIdExists: () => Promise.resolve(true),
  } as unknown as PiecesController;
}

/**
 * Helper for the cases below, which is a controller whose space answers
 * `holds` when a handle is looked up in it.
 *
 * The three answers are the lookup's own: `true` where the space holds the
 * piece, `false` where it does not, and `undefined` where the server does not
 * advertise the lookup and so says nothing either way. It takes no default for
 * the reason {@link controller}'s `name` takes none — `undefined` is one of
 * the answers rather than the absence of one.
 */
function lookingUp(holds: boolean | undefined): PiecesController {
  return {
    dispose: () => Promise.resolve(),
    getSpace: () => SPACE,
    getSpaceName: () => SPACE_NAME,
    entityIdExists: () => Promise.resolve(holds),
  } as unknown as PiecesController;
}

/** Helper for the cases below, which is the controller a shuttle borrows. */
const PIECES = controller(SPACE_NAME);

/** Helper for the cases below, which fails whichever read a case reaches. */
const READS_NOTHING: VerbDeps = {
  getCellValue: () => {
    throw new Error("A cell was read.");
  },
  readWish: () => {
    throw new Error("A wish was resolved.");
  },
  resolvePieceReference: () => {
    throw new Error("A piece was resolved.");
  },
  listing: {
    listSpaceSlugs: () => {
      throw new Error("The slug index was read.");
    },
    listPieces: () => {
      throw new Error("The pieces were read.");
    },
    listCellKeys: () => {
      throw new Error("The cell was listed.");
    },
  },
};

/**
 * Helper for the cases below, which is a shuttle standing at the space root,
 * over a connection opened as `pieces` says it was.
 */
function shuttleIn(pieces: PiecesController = PIECES): Shuttle {
  return {
    config: CONFIG,
    place: new CurrentPlace(SPACE),
    connection: new HeldConnection({ kind: "borrowed", pieces }),
  };
}

/** Helper for the cases below, which stands at a piece, at `path` inside it. */
function atPiece(...path: string[]): Shuttle {
  const shuttle = shuttleIn();
  moved(shuttle.place, `/${HANDLE}`);
  for (const segment of path) moved(shuttle.place, segment);
  return shuttle;
}

/** Helper for the cases below, which stands `value` in for a cell's value. */
function cellValue(value: unknown): VerbDeps {
  return { ...READS_NOTHING, getCellValue: () => Promise.resolve(value) };
}

/**
 * Helper for the cases below, which stands in the two answers a `cd` onto a
 * piece reads: the piece an address resolves to, and `value` for the cell the
 * path is checked against.
 *
 * `resolves` names the pieces the index points a slug at, and a token it has
 * no entry for resolves to itself — which is what the fabric does with a
 * handle, and what makes a case that is not about the resolution read as it
 * would have before there was one.
 */
function settling(
  value: unknown,
  resolves: Readonly<Record<string, string>> = {},
): VerbDeps {
  return {
    ...READS_NOTHING,
    resolvePieceReference: (_pieces, token, path) =>
      Promise.resolve({
        piece: resolves[token] ?? token,
        pathAfter: [...path],
      }),
    getCellValue: () => Promise.resolve(value),
  };
}

/**
 * Helper for the cases below, which stands `value` in for the cell a `cd`
 * checks its path against, and resolves no piece.
 *
 * The piece is left unresolved on purpose. A `cd` that spells the piece
 * shuttle already stands on has none to resolve, so a case standing at one
 * keeps `READS_NOTHING`'s resolution and fails if the settle reaches for it.
 * A case that moves onto another piece wants {@link settling} instead.
 */
function holding(value: unknown): VerbDeps {
  return { ...READS_NOTHING, getCellValue: () => Promise.resolve(value) };
}

/**
 * Helper for the cases below, which serves a different document per scope and
 * raises on a path it does not hold, the way a cell read does.
 *
 * The raise is the point: `getCellValue` throws where a path is not there
 * (`resolveCellPath`, `packages/runner/src/piece-helpers.ts`), so a fixture
 * that answered `undefined` instead would turn the failure a settle exists to
 * prevent into a quiet refusal and hide it.
 */
function atScopes(documents: Record<string, unknown>): VerbDeps {
  return {
    ...READS_NOTHING,
    resolvePieceReference: (_pieces, token, path) =>
      Promise.resolve({ piece: token, pathAfter: [...path] }),
    getCellValue: (config, path) => {
      let at: unknown = documents[config.pieceScope ?? "space"];
      for (const segment of path) {
        const key = String(segment);
        if (at === null || typeof at !== "object" || !(key in at)) {
          throw new Error(
            `Cannot access path "${path.join("/")}" - property "${key}" not ` +
              `found`,
          );
        }
        at = (at as Record<string, unknown>)[key];
      }
      return Promise.resolve(at);
    },
  };
}

/**
 * Helper for the cases below, which resolves `slug` as a collection — its
 * first path segment selecting the member — and answers a read by walking the
 * value below, so a walk of more than one segment is answered as the fabric
 * would answer it rather than by one stub value at every depth.
 */
function collectionAt(slug: string): VerbDeps {
  const value: Record<string, unknown> = {
    title: "a",
    topics: { 0: "x" },
    first: { title: "a" },
  };
  return {
    ...READS_NOTHING,
    resolvePieceReference: (_pieces, token, path) =>
      Promise.resolve(
        token === slug
          ? { piece: BOARD, pathAfter: [...path].slice(1) }
          : { piece: token, pathAfter: [...path] },
      ),
    getCellValue: (_config, path) => {
      let at: unknown = value;
      for (const segment of path) {
        at = (at as Record<string, unknown> | undefined)?.[String(segment)];
      }
      return Promise.resolve(at);
    },
  };
}

/** Helper for the cases below, which stands `keys` in for a cell's keys. */
function cellKeys(keys: string[]): VerbDeps {
  return {
    ...READS_NOTHING,
    listing: {
      ...READS_NOTHING.listing,
      listCellKeys: () => Promise.resolve(keys),
    },
  };
}

/** Helper for the cases below, which stands a wish's answer in for a read. */
function wishing(result: unknown, error?: string): VerbDeps {
  return {
    ...READS_NOTHING,
    readWish: () =>
      Promise.resolve({ result, ...(error === undefined ? {} : { error }) }),
  };
}

/**
 * Helper for the cases below, which answers a wish with the address `link`
 * names, the way a marked position does.
 *
 * The key is `packages/cli`'s own rather than a second spelling of it, so a
 * fixture and the reader that meets it cannot drift apart while both look
 * right.
 */
function addressed(link: string): VerbDeps {
  return wishing({ [LINK_MARKER_KEY]: link });
}

/** Helper for the cases below, which is the text `outcome` composed. */
function textOf(outcome: Outcome): string {
  return outcome.kind === "text" ? outcome.text : `not text: ${outcome.kind}`;
}

/** Helper for the cases below, which is the reason `outcome` was refused. */
function reasonOf(outcome: Outcome): string {
  return outcome.kind === "refused"
    ? outcome.reason
    : `not refused: ${outcome.kind}`;
}

/**
 * Helper for the cases below, which is every verb the dispatch takes, in the
 * order it lists them, with how many operands each one takes.
 *
 * It is written out rather than read off the table, so that a verb added
 * without a page, or with an arity nobody meant, fails a case here instead of
 * passing one that walks whatever it finds. What holds it to the table is the
 * case asserting that `help` lists exactly these and nothing else.
 */
const VERB_ARITY: readonly (readonly [
  string,
  "none" | "optional" | "required",
])[] = [
  ["cd", "required"],
  ["get", "optional"],
  ["help", "optional"],
  ["ls", "none"],
  ["pwd", "none"],
  ["where", "none"],
  ["wish", "required"],
];

/**
 * Helper for the cases below, which is what a verb needing an operand refuses
 * a line naming none with. A verb absent from this either takes no operand at
 * all or reads its own meaning into having none.
 */
const NEEDS_ONE: ReadonlyMap<string, string> = new Map([
  ["cd", "`cd` takes a place to move to."],
  ["wish", "`wish` takes the target to resolve, as in `wish #favorites`."],
]);

/** Helper for the cases below, which is every verb, in that same order. */
const VERB_WORDS = VERB_ARITY.map(([word]) => word);

describe("verbs", () => {
  describe("the dispatch", () => {
    it("returns nothing for a line naming no verb", async () => {
      expect(await runLine("   ", shuttleIn(), READS_NOTHING)).toEqual({
        kind: "nothing",
      });
    });

    it("returns a refusal naming a word that is no verb, and listing the verbs", async () => {
      expect(await runLine("frob x", shuttleIn(), READS_NOTHING)).toEqual({
        kind: "refused",
        reason: "`frob` is not a verb. The verbs are `cd`, `get`, `help`, " +
          "`ls`, `pwd`, `where`, and `wish`.",
      });
    });

    it("returns a refusal for a word naming a member every object carries", async () => {
      // A word a person can type is not a verb because the table happens to
      // answer for it. Looked up on an object, three of these hand back a
      // function of `Object.prototype`'s and each fails its own way: `toString`
      // and `constructor` return something that is no outcome — the second of
      // them the shuttle record itself, identity path and all — while `valueOf`
      // and `hasOwnProperty` throw out of the dispatch, where a throw means a
      // read that failed. `__proto__` answers with nothing and was already
      // refused, and it is here so that it stays refused.

      for (
        const word of [
          "toString",
          "constructor",
          "valueOf",
          "hasOwnProperty",
          "__proto__",
        ]
      ) {
        expect(await runLine(word, shuttleIn(), READS_NOTHING)).toEqual({
          kind: "refused",
          reason: `\`${word}\` is not a verb. The verbs are \`cd\`, \`get\`, ` +
            "`help`, `ls`, `pwd`, `where`, and `wish`.",
        });
      }
    });

    it("returns the reason the split gave a line it would not split", async () => {
      expect(await runLine("get 'a", shuttleIn(), READS_NOTHING)).toEqual({
        kind: "refused",
        reason: "The `'` opened at column 5 is never closed.",
      });
    });

    it("writes nothing itself, whichever verb the line names", async () => {
      // The one claim in this file about what a verb does *not* do, and the
      // one that no other case could show. `render()` — what every `cf` seam
      // reaches for — writes through `Deno.stdout.writeSync`, so the recorder
      // stands in for that member and the case opens by proving the recorder
      // sees a write, without which it would pass over a verb that wrote
      // through it all day.

      const written: number[] = [];
      const stdout = Deno.stdout.writeSync;
      const stderr = Deno.stderr.writeSync;
      Deno.stdout.writeSync = (data) => {
        written.push(data.length);
        return data.length;
      };
      Deno.stderr.writeSync = Deno.stdout.writeSync;
      try {
        Deno.stdout.writeSync(new Uint8Array([0x61]));
        expect(written).toEqual([1]);
        written.length = 0;
        const answers: VerbDeps = {
          getCellValue: () => Promise.resolve("a"),
          readWish: () => Promise.resolve({ result: "b" }),
          listing: { listCellKeys: () => Promise.resolve(["title"]) },
        };
        const shuttle = atPiece();
        for (
          const line of [
            "pwd",
            "where",
            "ls",
            "get",
            "wish #favorites",
            "cd ..",
            "help",
          ]
        ) {
          await runLine(line, shuttle, answers);
        }
      } finally {
        Deno.stdout.writeSync = stdout;
        Deno.stderr.writeSync = stderr;
      }
      expect(written).toEqual([]);
    });
  });

  describe("the option grammar", () => {
    it("hands a token opening with `-` to no verb, and refuses it as an option nobody declared", async () => {
      expect(reasonOf(await runLine("ls -x", shuttleIn(), READS_NOTHING)))
        .toBe(
          'Unknown option "-x". Did you mean option "-h"? `ls --help` says ' +
            "what `ls` takes.",
        );
    });

    it("hands `-` on its own to the verb as an operand, it being the previous place", async () => {
      // The one token the rule turns on that a shipped verb already spends:
      // read as an option it would refuse here as `-x` does, and the reason
      // it gives instead is the place's own.

      expect(reasonOf(await runLine("cd -", shuttleIn(), READS_NOTHING)))
        .toBe("There is no previous place to return to.");
    });

    it("hands a token after a bare `--` on as an operand, though it opens with `-`", async () => {
      expect(reasonOf(await runLine("cd -- -x", shuttleIn(), READS_NOTHING)))
        .toBe(
          "A space root lists facets, and `-x` names none. The facets are " +
            "`slugs/` and `pieces/`.",
        );
    });

    it("takes back the operand a listing offers for a key it would otherwise eat", async () => {
      // The composed claim the rule puts at risk: a listing prints a name to
      // be typed back, and a token opening with `-` never reaches a verb as an
      // operand. What closes it is the reference, which opens with `/`.

      const shuttle = atPiece();
      const operand = operandForChild(shuttle.place.place, "-x");
      expect(operand).toBeDefined();
      await runLine(`cd ${operand}`, shuttle, holding({ "-x": 1 }));
      expect(shuttle.place.place.position).toEqual({
        kind: "piece",
        space: SPACE,
        piece: HANDLE,
        path: ["-x"],
      });
    });

    it("takes a key called `--` by the second one, only the first ending the options", async () => {
      // The typed spelling and what a listing offers are two questions. The
      // listing prints the reference for this key, `readsAsOption` taking the
      // name; the line below is what a person can type for it either way.

      const shuttle = atPiece();
      await runLine("cd -- --", shuttle, holding({ "--": 1 }));
      expect(shuttle.place.place.position).toEqual({
        kind: "piece",
        space: SPACE,
        piece: HANDLE,
        path: ["--"],
      });
    });

    it("counts the operands rather than the tokens, a bare `--` being neither", async () => {
      const shuttle = shuttleIn();
      expect(await runLine("cd -- slugs", shuttle, READS_NOTHING))
        .toEqual({ kind: "moved", place: shuttle.place.place });
    });
  });

  describe("`--help`", () => {
    // One case per verb rather than one case walking them, because what is
    // claimed is of each: the dispatch puts the option in front of whatever a
    // verb declared, so a verb that stopped taking it names itself here.

    for (const word of VERB_WORDS) {
      it(`writes \`${word}\`'s page, which \`help ${word}\` writes too`, async () => {
        const opening = `Usage: ${word}`;
        const byOption = textOf(
          await runLine(`${word} --help`, shuttleIn(), READS_NOTHING),
        );
        expect(byOption.slice(0, opening.length)).toBe(opening);
        expect(
          textOf(await runLine(`help ${word}`, shuttleIn(), READS_NOTHING)),
        )
          .toBe(byOption);
      });
    }

    it("writes the page though an operand was written beside the option", async () => {
      // The option takes the whole reading, so the operand beside it reaches
      // no verb. What each case above shows is the other half: a verb that ran
      // instead would answer with its own refusal for the operands it was not
      // given, and none of these would be text at all.

      expect(
        textOf(await runLine("cd --help slugs", shuttleIn(), READS_NOTHING))
          .split("\n")[0],
      ).toBe("Usage: cd <ref>");
    });
  });

  describe("arity", () => {
    // How many operands a verb takes is the dispatch table's, and the dispatch
    // is what holds a verb to it, so there is one case per verb here rather
    // than one in each verb's own block. What a case turns on is the entry it
    // reads, so a count changed there names the verb it was changed for.

    for (const [word, arity] of VERB_ARITY) {
      const given = arity === "none" ? 1 : 2;
      it(`refuses ${given} operand${given === 1 ? "" : "s"}, one more than \`${word}\` takes`, async () => {
        const line = [word, ...["a", "b"].slice(0, given)].join(" ");
        expect(reasonOf(await runLine(line, shuttleIn(), READS_NOTHING)))
          .toBe(
            arity === "none"
              ? `\`${word}\` takes no operand, and was given 1.`
              : `\`${word}\` takes one operand, and was given 2.`,
          );
      });
    }

    for (const [word, arity] of VERB_ARITY) {
      if (arity !== "required") continue;
      it(`refuses a line naming no operand, \`${word}\` needing one`, async () => {
        expect(reasonOf(await runLine(word, shuttleIn(), READS_NOTHING)))
          .toBe(NEEDS_ONE.get(word));
      });
    }

    for (const [word, arity] of VERB_ARITY) {
      if (arity !== "optional") continue;
      it(`runs \`${word}\` given no operand, which is a default and not too few`, async () => {
        // The half a maximum alone cannot express. `get` reads where it stands
        // and `help` lists the verbs, so neither is a line the dispatch may
        // answer for, and a count refusing none would take both readings away.

        const outcome = await runLine(word, atPiece(), cellValue("a value"));
        expect(outcome.kind).not.toBe("refused");
      });
    }

    it("counts the operands it was given rather than the count the verb takes", async () => {
      expect(reasonOf(await runLine("pwd a b c", shuttleIn(), READS_NOTHING)))
        .toBe("`pwd` takes no operand, and was given 3.");
    });
  });

  describe("help", () => {
    it("lists every verb, one to a row, and nothing else", async () => {
      // The list and the dispatch read one table, so a verb the dispatch
      // takes and this does not list is a verb a person has no way to find.
      // The last two lines are the blank and the line naming the option.

      const lines = textOf(await runLine("help", shuttleIn(), READS_NOTHING))
        .split("\n");
      expect(lines.slice(0, -2).map((row) => row.split(" ")[0]))
        .toEqual(VERB_WORDS);
    });

    it("refuses a word that names no verb, in the sentence the dispatch refuses one in", async () => {
      expect(reasonOf(await runLine("help frob", shuttleIn(), READS_NOTHING)))
        .toBe(
          "`frob` is not a verb. The verbs are `cd`, `get`, `help`, `ls`, " +
            "`pwd`, `where`, and `wish`.",
        );
    });
  });

  describe("cd", () => {
    it("returns the place a relative operand moved to", async () => {
      const shuttle = shuttleIn();
      const outcome = await runLine("cd slugs", shuttle, READS_NOTHING);
      expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
      expect(shuttle.place.place.position).toEqual({
        kind: "facet",
        space: SPACE,
        facet: "slugs",
      });
    });

    it("returns the reason a place gave an operand it would not take, and moves nowhere", async () => {
      const shuttle = shuttleIn();
      const before = shuttle.place.place;
      const outcome = await runLine("cd nowhere", shuttle, READS_NOTHING);
      expect(reasonOf(outcome)).toBe(
        "A space root lists facets, and `nowhere` names none. The facets are " +
          "`slugs/` and `pieces/`.",
      );
      expect(shuttle.place.place).toBe(before);
    });

    it("returns the place's own refusal for an operand that is the empty string", async () => {
      // One operand, so the dispatch hands it on and `movePlace`'s guard is
      // what answers — in the sentence the dispatch composes for a line naming
      // no operand at all, so the two spellings read alike.

      expect(reasonOf(await runLine("cd ''", shuttleIn(), READS_NOTHING)))
        .toBe("`cd` takes a place to move to.");
    });

    it("refuses an operand ending in `#argument`, a place being result-rooted", async () => {
      // The asymmetry `get`'s own door turns on: `cd` refuses the suffix in
      // every spelling that takes one, and `get` reads it.
      const shuttle = shuttleIn();
      moved(shuttle.place, "slugs");
      expect(
        reasonOf(await runLine("cd board#argument", shuttle, READS_NOTHING)),
      )
        .toBe(
          "A place is result-rooted, so `cd` takes no `#argument` suffix. A " +
            "place rooted at the arguments cell would leave every later " +
            "relative read ambiguous about which side of the piece it " +
            "addressed. Reach arguments per operand instead, as in " +
            "`get topics/3#argument`.",
        );
    });

    describe("the read that settles a move", () => {
      // What makes `cd` a promise. A move onto a piece is asked of the fabric
      // before the place is adopted — the piece resolved, and the path found —
      // so the prompt after a `cd` names a place that is there, and a place
      // that is not there is refused here rather than reported by whichever
      // verb reads next.

      /** Helper for the cases below, which is a second piece to move onto. */
      const OTHER = "of:fid1:0123456789abcdef";

      /**
       * Helper for the cases below, which is where a settle read, and the
       * piece it read through.
       */
      async function read(
        shuttle: Shuttle,
        line: string,
        value: unknown,
      ): Promise<{ config?: PieceConfig; path?: (string | number)[] }> {
        const seen: { config?: PieceConfig; path?: (string | number)[] } = {};
        await runLine(line, shuttle, {
          ...settling(value),
          getCellValue: (config, path) => {
            seen.config = config;
            seen.path = path;
            return Promise.resolve(value);
          },
        });
        return seen;
      }

      it("lands the handle the piece resolved to, with the slug as the name", async () => {
        const shuttle = shuttleIn();
        moved(shuttle.place, "slugs");
        await runLine("cd board", shuttle, settling(null, { board: BOARD }));
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: BOARD,
          name: "board",
          path: [],
        });
      });

      it("hands the resolution the connection this process holds", async () => {
        const shuttle = shuttleIn();
        moved(shuttle.place, "slugs");
        let asked: unknown;
        await runLine("cd board", shuttle, {
          ...READS_NOTHING,
          resolvePieceReference: (pieces, token, path) => {
            asked = pieces;
            return Promise.resolve({ piece: token, pathAfter: [...path] });
          },
        });
        expect(asked).toBe(PIECES);
      });

      it("refuses a slug the index names nothing for, and moves nowhere", async () => {
        const shuttle = shuttleIn();
        moved(shuttle.place, "slugs");
        const before = shuttle.place.place;
        const outcome = await runLine("cd todo", shuttle, {
          ...READS_NOTHING,
          resolvePieceReference: () => {
            throw new SlugResolutionError('Slug "todo" not found.', "missing");
          },
        });
        expect(reasonOf(outcome)).toBe(
          '`todo` reaches no piece: Slug "todo" not found.',
        );
        expect(shuttle.place.place).toBe(before);
      });

      it("raises what a resolution that failed for another reason raised", async () => {
        // A slug that names nothing is a fact about the line. A connection
        // that went away is not, and the two have to stay told apart.

        const shuttle = shuttleIn();
        moved(shuttle.place, "slugs");
        await expect(runLine("cd todo", shuttle, READS_NOTHING)).rejects
          .toThrow("A piece was resolved.");
      });

      it("refuses a handle the space does not hold, and moves nowhere", async () => {
        // A handle is a spelling and not a lookup, so the resolution hands one
        // back unread. The space's own index is what tells a piece it holds
        // from one it does not, where a value read cannot: an absent piece
        // reads as nothing, and so does an empty one.

        const shuttle = shuttleIn(lookingUp(false));
        moved(shuttle.place, "pieces");
        const before = shuttle.place.place;
        expect(reasonOf(await runLine(`cd ${HANDLE}`, shuttle, settling(null))))
          .toBe(
            `\`${HANDLE}\` reaches no piece: this space holds none by the ` +
              `handle \`${HANDLE}\`.`,
          );
        expect(shuttle.place.place).toBe(before);
      });

      it("lands a handle the space holds", async () => {
        const shuttle = shuttleIn(lookingUp(true));
        moved(shuttle.place, "pieces");
        const outcome = await runLine(`cd ${HANDLE}`, shuttle, settling(null));
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
      });

      it("lands a handle where the server does not answer the lookup", async () => {
        // The lookup is a server capability, and `undefined` is what a server
        // that does not advertise it says. Nothing was learned, so the move
        // goes on — which is the one case left where a handle the space does
        // not hold is adopted.

        const shuttle = shuttleIn(lookingUp(undefined));
        moved(shuttle.place, "pieces");
        const outcome = await runLine(`cd ${HANDLE}`, shuttle, settling(null));
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
      });

      it("looks up no handle for a slug, the index having reached the piece", async () => {
        // A slug resolved through the index, which read the document to take
        // its id, so the resolution is the existence proof and a second one
        // would ask what is answered.

        const shuttle = shuttleIn(lookingUp(false));
        moved(shuttle.place, "slugs");
        const outcome = await runLine(
          "cd board",
          shuttle,
          settling(null, { board: BOARD }),
        );
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
      });

      it("looks up no handle for a key under the piece already stood at", async () => {
        const shuttle: Shuttle = {
          config: CONFIG,
          place: new CurrentPlace(SPACE),
          connection: new HeldConnection({
            kind: "borrowed",
            pieces: lookingUp(false),
          }),
        };
        moved(shuttle.place, `/${HANDLE}`);
        const outcome = await runLine(
          "cd topics",
          shuttle,
          holding({ topics: [] }),
        );
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
      });

      it("lands the resolved piece in the route, not only on top of it", async () => {
        // A trail is made of positions `..` walks back through, so a route
        // entry holding an unresolved slug is a place shuttle returns to and
        // reads through the index as it points then. The invariant is the
        // route's as much as the destination's.

        const shuttle = shuttleIn();
        await runLine(
          "cd /slugs/board/topics",
          shuttle,
          settling({ topics: [] }, { board: BOARD }),
        );
        await runLine("cd ..", shuttle, READS_NOTHING);
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: BOARD,
          name: "board",
          path: [],
        });
      });

      it("takes `./items@user` to that key though the piece holds one named `.`", async () => {
        // The silent wrong landing the head reading ends. Read as a walk, the
        // operand descends through a key called `.` — and where the piece
        // holds one, that walk *succeeds*, so the settle confirms it and the
        // place adopts a cell nobody named. The head is read first, so the
        // cell reached is the one the operand names whatever the piece holds.

        const shuttle = atPiece();
        const outcome = await runLine(
          "cd ./items@user",
          shuttle,
          settling({ ".": { "items@user": 99 }, "items@user": 1 }),
        );
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: HANDLE,
          path: ["items@user"],
        });
      });

      it("offers the `.@` spelling where a bare scope word names no key", async () => {
        // Inside a piece a bare `@session` is an ordinary key name, so this
        // is the read finding no such key — and the operand looks enough like
        // an attempt at the scope to say what would have moved it.

        expect(
          reasonOf(
            await runLine("cd @session", atPiece(), settling({ topics: 1 })),
          ),
        ).toBe(
          "`@session` reaches no cell: `@session` is no key of the cell " +
            "above it, whose keys are `topics`. `.@session` is what moves " +
            "the scope.",
        );
      });

      it("reaches a key genuinely named `@session`, with no offer made", async () => {
        // The condition the offer hangs on. A place that holds the key lands
        // on it, and nothing is suggested, because nothing went wrong.

        const shuttle = atPiece();
        const outcome = await runLine(
          "cd @session",
          shuttle,
          settling({ "@session": 1 }),
        );
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: HANDLE,
          path: ["@session"],
        });
        expect(shuttle.place.place.scope).toBe("space");
      });

      it("settles a scope on its own, reading the place at the scope it moves to", async () => {
        // A scope selects which document a piece's id names, so the place a
        // scope move reaches is one nothing has read. It settles like any
        // other move onto a piece, and the read goes to the new scope.

        const shuttle = shuttleIn();
        await runLine(`cd /${HANDLE}/topics`, shuttle, settling({ topics: 1 }));
        let scope: string | undefined;
        const outcome = await runLine("cd .@session", shuttle, {
          ...settling({ topics: 1 }),
          getCellValue: (config) => {
            scope = config.pieceScope;
            return Promise.resolve({ topics: 1 });
          },
        });
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
        expect(scope).toBe("session");
      });

      it("refuses a scope whose document does not hold the path, and moves nowhere", async () => {
        // The chain the settle exists for, in one line rather than two: the
        // place at `@space` holds `topics`, the one at `@session` does not,
        // and the move that would have adopted it is refused instead.

        const shuttle = shuttleIn();
        await runLine(`cd /${HANDLE}/topics`, shuttle, settling({ topics: 1 }));
        const before = shuttle.place.place;
        const outcome = await runLine("cd .@session", shuttle, settling({}));
        expect(reasonOf(outcome)).toBe(
          "`.@session` reaches no cell: `topics` is no key of the cell above " +
            "it, which holds no keys at all.",
        );
        expect(shuttle.place.place).toBe(before);
      });

      it("descends after a refused scope move without meeting the runtime", async () => {
        // The chain rather than the unit: settle at one scope, change scope,
        // descend. The piece holds `topics/child` at `@space` and nothing at
        // `@session`, so the scope move is refused and the descent runs from
        // the place that was never left — reading a level that is there.
        //
        // A scope move that landed instead would leave the place at
        // `@session/topics`, which no read confirmed, and the descent would
        // read that parent and raise. So the third line is the assertion: it
        // lands, rather than rejecting with the runtime's sentence.

        const deps = atScopes({
          space: { topics: { child: 1 } },
          session: {},
        });
        const shuttle = shuttleIn();
        await runLine(`cd /${HANDLE}/topics`, shuttle, deps);
        expect(reasonOf(await runLine("cd .@session", shuttle, deps))).toBe(
          "`.@session` reaches no cell: `topics` is no key of the cell above " +
            "it, which holds no keys at all.",
        );
        const descended = await runLine("cd child", shuttle, deps);
        expect(descended).toEqual({
          kind: "moved",
          place: shuttle.place.place,
        });
        expect(shuttle.place.place).toEqual({
          position: {
            kind: "piece",
            space: SPACE,
            piece: HANDLE,
            path: ["topics", "child"],
          },
          scope: "space",
        });
      });

      it("looks the handle up again where the move changes only the scope", async () => {
        // The lookup's own skip, keyed the same way as the read's: one id at
        // two scopes is two documents, so a move to the second has a piece
        // nothing has asked about even though the id is one shuttle stands on.

        // Standing is set through the place directly, which makes no lookup,
        // so the one the case is about is the only one the controller sees.
        const shuttle = shuttleIn(lookingUp(false));
        moved(shuttle.place, `/${HANDLE}`);
        const before = shuttle.place.place;
        expect(reasonOf(
          await runLine(`cd /${HANDLE}@session`, shuttle, settling(null)),
        )).toBe(
          `\`/${HANDLE}@session\` reaches no piece: this space holds none ` +
            `by the handle \`${HANDLE}\`.`,
        );
        expect(shuttle.place.place).toBe(before);
      });

      it("looks the handle up once for the cell it already stands at", async () => {
        // The other side of that key: same id, same scope, so the piece was
        // settled when shuttle arrived and a move naming it again asks
        // nothing. The controller refuses every lookup, so one being made
        // would fail the case.

        const shuttle = shuttleIn(lookingUp(false));
        moved(shuttle.place, `/${HANDLE}`);
        const outcome = await runLine(
          `cd /${HANDLE}`,
          shuttle,
          settling(null),
        );
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
      });

      it("reads again where the move changes only the scope", async () => {
        // One id at `@space` and the same id at `@session` are two documents,
        // so a place confirmed at one is not confirmed at the other. A skip
        // that compared the position alone would land here having read
        // nothing.

        const shuttle = shuttleIn();
        await runLine(`cd /${HANDLE}/topics`, shuttle, settling({ topics: 1 }));
        const outcome = await runLine(
          `cd /${HANDLE}@session/topics`,
          shuttle,
          settling({ other: 1 }),
        );
        expect(reasonOf(outcome)).toBe(
          "`/of:fid1:abcdefghijklmnop@session/topics` reaches no cell: " +
            "`topics` is no key of the cell above it, whose keys are `other`.",
        );
      });

      it("reads at the level stood at where only the path goes deeper", async () => {
        // The other side of every boundary above: same piece, same scope, one
        // key deeper. Where shuttle stands is a place a read already
        // confirmed, so what the settle has to find is the segment past it
        // rather than the whole piece.

        const seen = await read(atPiece("topics"), "cd 0", ["a"]);
        expect(seen.path).toEqual(["topics"]);
      });

      it("settles a slug that names a collection, as a read of it would", async () => {
        // The canonical resolution spends leading segments reaching a
        // collection's member, so `/tasks/first/title` names the member's
        // piece with `title` left inside it. Settling the head as a bare piece
        // would refuse a cell `get` reads, and two verbs disagreeing about
        // whether a reference names anything is worse than either answer.

        const shuttle = shuttleIn();
        await runLine(`cd /tasks/first/title`, shuttle, {
          ...READS_NOTHING,
          resolvePieceReference: (_pieces, token, path) =>
            Promise.resolve(
              token === "tasks"
                ? { piece: BOARD, pathAfter: [...path].slice(1) }
                : { piece: token, pathAfter: [...path] },
            ),
          getCellValue: () => Promise.resolve({ title: "a" }),
        });
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: BOARD,
          path: ["title"],
        });
      });

      it("keeps the member's own levels in a route a collection resolved through", async () => {
        // The resolution spends the levels that select the member, and those
        // are levels of the collection rather than of what it held. The level
        // the member itself sits at is the member's, and lands with the
        // member's piece — so `..` reaches the member's root, not the facet
        // two levels above it.

        const shuttle = shuttleIn();
        await runLine(
          "cd slugs/tasks/first/title",
          shuttle,
          collectionAt("tasks"),
        );
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: BOARD,
          path: ["title"],
        });
        await runLine("cd ..", shuttle, READS_NOTHING);
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: BOARD,
          path: [],
        });
        await runLine("cd ..", shuttle, READS_NOTHING);
        expect(shuttle.place.place.position).toEqual({
          kind: "facet",
          space: SPACE,
          facet: "slugs",
        });
      });

      it("routes one walk the same whether it is typed whole or in steps", async () => {
        // A route records how shuttle reached a place, and `cd a/b/c` and
        // `cd a/b` then `cd c` are one walk written two ways. So they leave
        // the same route, and `..` lands the same sequence from either — the
        // property that catches a resolution spending segments and taking the
        // levels below them with it.

        /** Every `..` landing from `lines`, after where they end. */
        const landings = async (lines: string[]): Promise<unknown[]> => {
          const shuttle = shuttleIn();
          for (const line of lines) {
            await runLine(line, shuttle, collectionAt("tasks"));
          }
          const seen: unknown[] = [shuttle.place.place.position];
          for (let step = 0; step < 3; step++) {
            await runLine("cd ..", shuttle, READS_NOTHING);
            seen.push(shuttle.place.place.position);
          }
          return seen;
        };

        expect(await landings(["cd slugs/tasks/first/title"]))
          .toEqual(await landings(["cd slugs/tasks/first", "cd title"]));
        expect(await landings(["cd slugs/board/topics"]))
          .toEqual(await landings(["cd slugs/board", "cd topics"]));
      });

      it("takes the scope a narrowed link was reached through", async () => {
        // A member held through a narrowed link is a different document from
        // the one its id alone names, so the place has to read through the
        // scope the resolution reached it at.

        const shuttle = shuttleIn();
        await runLine(`cd /tasks/first`, shuttle, {
          ...READS_NOTHING,
          resolvePieceReference: (_pieces, _token, path) =>
            Promise.resolve({
              piece: BOARD,
              pathAfter: [...path].slice(1),
              scope: "session",
            }),
        });
        expect(shuttle.place.place.scope).toBe("session");
      });

      it("reads the path through the scope the resolution reached it at", async () => {
        // The place's scope and the read's are the same scope, and the read
        // has to use it: a member held through a narrowed link is a different
        // document, so checking its path at the ambient scope would look for
        // the key in a cell the place does not name.

        const shuttle = shuttleIn();
        let scope: string | undefined;
        await runLine(`cd /tasks/first/title`, shuttle, {
          ...READS_NOTHING,
          resolvePieceReference: (_pieces, _token, path) =>
            Promise.resolve({
              piece: BOARD,
              pathAfter: [...path].slice(1),
              scope: "session",
            }),
          getCellValue: (config) => {
            scope = config.pieceScope;
            return Promise.resolve({ title: "a" });
          },
        });
        expect(scope).toBe("session");
        expect(shuttle.place.place.scope).toBe("session");
      });

      it("resolves a slug reached from inside another piece", async () => {
        // Standing at a piece is not standing at *this* piece. The skip above
        // is for the one the place already holds, and a move onto any other
        // resolves — which is the whole of what keeps a repointed slug from
        // walking the place onto a piece it did not name.

        const shuttle = atPiece("topics");
        await runLine(
          "cd /slugs/board",
          shuttle,
          settling(null, { board: BOARD }),
        );
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: BOARD,
          name: "board",
          path: [],
        });
      });

      it("resolves nothing for a key under the piece already stood at", async () => {
        // The piece is the one shuttle stands on, which came through a settle
        // of its own, so a descent has none left to ask about. `READS_NOTHING`
        // resolves none, and the case fails if the settle reaches for one.

        const shuttle = atPiece();
        await runLine("cd topics", shuttle, holding({ topics: [] }));
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: HANDLE,
          path: ["topics"],
        });
      });

      it("resolves nothing for a reference naming the piece already stood at", async () => {
        const shuttle = atPiece("topics");
        await runLine(
          `cd /${HANDLE}/title`,
          shuttle,
          holding({ title: "a" }),
        );
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: HANDLE,
          path: ["title"],
        });
      });

      it("raises what the read that checks the path raised", async () => {
        // The seam's own distinction, on the door this slice added. A slug
        // the index names nothing for is a fact about the line and comes back
        // refused; a read that failed is a server that went away, and it
        // raises so a shell whose server is gone is still a shell. The
        // message is asserted because both stubs in `READS_NOTHING` throw,
        // and only one of them is the read.

        await expect(runLine("cd title", atPiece(), READS_NOTHING)).rejects
          .toThrow("A cell was read.");
      });

      it("refuses a segment that is no key, naming the keys that are", async () => {
        const shuttle = atPiece();
        const before = shuttle.place.place;
        const outcome = await runLine(
          "cd nosuchkey",
          shuttle,
          settling({ value: 0, increment: null, decrement: null }),
        );
        expect(reasonOf(outcome)).toBe(
          "`nosuchkey` reaches no cell: `nosuchkey` is no key of the cell " +
            "above it, whose keys are `value`, `increment`, and `decrement`.",
        );
        expect(shuttle.place.place).toBe(before);
      });

      it("refuses a segment where the cell above it holds no keys at all", async () => {
        expect(
          reasonOf(await runLine("cd title", atPiece(), settling(7))),
        ).toBe(
          "`title` reaches no cell: `title` is no key of the cell above it, " +
            "which holds no keys at all.",
        );
      });

      it("names the segment that is missing rather than the operand's last", async () => {
        expect(
          reasonOf(
            await runLine(
              "cd nosuchkey/title",
              atPiece(),
              settling({ topics: [] }),
            ),
          ),
        ).toBe(
          "`nosuchkey/title` reaches no cell: `nosuchkey` is no key of the " +
            "cell above it, whose keys are `topics`.",
        );
      });

      it("lands a key the read found", async () => {
        const shuttle = atPiece();
        const outcome = await runLine(
          "cd topics",
          shuttle,
          settling({ topics: [] }),
        );
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: HANDLE,
          path: ["topics"],
        });
      });

      it("reads an index a walk into an array reached", async () => {
        const shuttle = atPiece("topics");
        const outcome = await runLine(
          "cd 3",
          shuttle,
          settling(["a", 1, 2, 3]),
        );
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
      });

      it("reads at the piece's root where the move went up before it came down", async () => {
        const seen = await read(atPiece("topics"), "cd ../items", {
          items: {},
        });
        expect(seen.path).toEqual([]);
      });

      it("reads at the piece's root for a move onto another piece", async () => {
        // The path a move onto another piece extends is a path in that
        // piece, so a standing that spells the same segments has confirmed
        // nothing about it. The operand shares its first segment with where
        // shuttle stands, which is what makes the piece the thing deciding.

        const seen = await read(atPiece("topics"), `cd /${OTHER}/topics/3`, {
          topics: ["a", "b", "c", "d"],
        });
        expect(seen.path).toEqual([]);
        expect(seen.config?.piece).toBe(OTHER);
      });

      it("reads at the scope the move lands at, not the one it left", async () => {
        // A reference carrying a suffix moves both halves of the place, and
        // the cell the read has to find is the one that scope selects.

        const seen = await read(
          atPiece(),
          `cd /${HANDLE}@session/title`,
          { title: 1 },
        );
        expect(seen.config?.pieceScope).toBe("session");
      });

      it("reads nothing at all for a move onto a piece with no path", async () => {
        // Nothing is left to find: the resolution answered for the piece, and
        // there is no path under it for a read to look for.

        const shuttle = shuttleIn();
        moved(shuttle.place, "pieces");
        const outcome = await runLine(`cd ${HANDLE}`, shuttle, {
          ...READS_NOTHING,
          resolvePieceReference: (_pieces, token, path) =>
            Promise.resolve({ piece: token, pathAfter: [...path] }),
        });
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
      });

      it("reads through the piece the resolution handed back", async () => {
        const shuttle = shuttleIn();
        moved(shuttle.place, "slugs");
        let piece: string | undefined;
        await runLine("cd board/title", shuttle, {
          ...settling({ title: 1 }, { board: BOARD }),
          getCellValue: (config) => {
            piece = config.piece;
            return Promise.resolve({ title: 1 });
          },
        });
        expect(piece).toBe(BOARD);
      });

      it("writes the name in the prompt and the handle in what `pwd` prints", async () => {
        const shuttle = shuttleIn();
        moved(shuttle.place, "slugs");
        await runLine("cd board", shuttle, settling(null, { board: BOARD }));
        expect(shuttle.place.label()).toBe("board @space");
        expect(textOf(await runLine("pwd", shuttle, READS_NOTHING))).toBe(
          `position  /@${SPACE}/${BOARD}@space\nscope     @space`,
        );
      });

      it("settles a space written as a name before it settles the piece", async () => {
        const shuttle = shuttleIn();
        await runLine(
          `cd /@${SPACE_NAME}/board/title`,
          shuttle,
          settling({ title: 1 }, { board: BOARD }),
        );
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: BOARD,
          name: "board",
          path: ["title"],
        });
      });

      it("refuses an entry point resolving to an address naming its piece by slug", async () => {
        expect(
          reasonOf(
            await runLine("cd #favorites", shuttleIn(), addressed("/board")),
          ),
        ).toBe(
          "`#favorites` resolves to slug `board`, and a place holds the " +
            "handle a name resolved to. An address the fabric wrote names " +
            "its piece by handle.",
        );
      });

      it("settles nothing for `get`, whose own read is what finds the cell", async () => {
        // The asymmetry the two doors have. A `cd` waits because the prompt
        // would go on promising the place; a read of a cell that is not there
        // fails on its own account, so there is nothing for a check in front
        // of it to add — and `READS_NOTHING` resolves no piece, which is what
        // shows that none was asked for.

        expect(await runLine("get title", atPiece(), cellValue("read")))
          .toEqual({ kind: "value", value: "read" });
      });
    });

    describe("a `#name` target", () => {
      it("lands on the piece the fabric resolved the target to", async () => {
        const shuttle = shuttleIn();
        const outcome = await runLine(
          "cd #favorites",
          shuttle,
          addressed(`/${HANDLE}/topics/3`),
        );
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: HANDLE,
          path: ["topics", 3],
        });
      });

      it("asks the wish for the target's address rather than for its value", async () => {
        let asked: WishReadConfig | undefined;
        await runLine("cd #favorites", shuttleIn(), {
          ...READS_NOTHING,
          readWish: (config) => {
            asked = config;
            return Promise.resolve({
              result: { [LINK_MARKER_KEY]: `/${HANDLE}` },
            });
          },
        });
        expect(asked?.query).toBe("#favorites");
        expect(asked?.selection?.projection?.markers).toEqual({ marked: true });
        expect(asked?.selection?.projection?.schema).toBe(false);
      });

      it("hands the wish the connection this process holds", async () => {
        let loaded: unknown;
        await runLine("cd #favorites", shuttleIn(), {
          ...READS_NOTHING,
          readWish: async (config, deps) => {
            loaded = await deps?.loadPieces?.(config);
            return { result: { [LINK_MARKER_KEY]: `/${HANDLE}` } };
          },
        });
        expect(loaded).toBe(PIECES);
      });

      it("refuses a target the fabric resolved in another space, and says what would reach it", async () => {
        const shuttle = shuttleIn();
        const outcome = await runLine(
          "cd #profile",
          shuttle,
          addressed(`/@${OTHER_SPACE}/${HANDLE}`),
        );
        expect(reasonOf(outcome)).toBe(
          "`#profile` resolves in space `did:key:z6MkHomeSpace`, and this " +
            "shuttle is connected to `did:key:z6MkConnectedSpace`. One " +
            "connection serves one space, so reaching that cell means a " +
            "shuttle started against that space.",
        );
        expect(shuttle.place.place.position.kind).toBe("root");
      });

      it("refuses a target whose address carries a scope qualifier", async () => {
        const outcome = await runLine(
          "cd #favorites",
          shuttleIn(),
          addressed(`/${HANDLE}@session/title`),
        );
        expect(reasonOf(outcome)).toBe(
          "`#favorites` resolved to an address carrying an `@session` " +
            "qualifier, which a place reached through a target does not " +
            "keep: a " +
            "place holds one scope and roots at a result. Reach that cell by " +
            `its own reference, \`/${HANDLE}@session/title\`.`,
        );
      });

      it("refuses a target whose address carries the `#argument` suffix", async () => {
        const outcome = await runLine(
          "cd #favorites",
          shuttleIn(),
          addressed(`/${HANDLE}/title#argument`),
        );
        expect(reasonOf(outcome)).toBe(
          "`#favorites` resolved to an address carrying the `#argument` " +
            "suffix, which a place reached through a target does not keep: a " +
            "place holds one scope and roots at a result. Reach that cell by " +
            `its own reference, \`/${HANDLE}/title#argument\`.`,
        );
      });

      it("refuses an address naming its space by a name rather than a DID", async () => {
        // An address the fabric wrote names its space by DID or leaves it
        // out, so a name in that slot is an answer nothing here can compare
        // against the connected space — and comparing it wrongly is what
        // decision 5's whole refusal turns on.
        const outcome = await runLine(
          "cd #favorites",
          shuttleIn(),
          addressed(`/@estuary/${HANDLE}`),
        );
        expect(reasonOf(outcome)).toBe(
          "`#favorites` resolved to an address naming space `estuary`, " +
            "which is no DID. An address the fabric wrote names its space by " +
            "DID or leaves it out.",
        );
      });

      it("refuses an address that is not written as a reference", async () => {
        expect(
          reasonOf(
            await runLine("cd #favorites", shuttleIn(), addressed(HANDLE)),
          ),
        ).toBe(
          `\`#favorites\` resolved to \`${HANDLE}\`, which is no reference: ` +
            "one is rooted, and this is not.",
        );
      });

      it("carries the reason the reference grammar gave an address it refused", async () => {
        expect(
          reasonOf(
            await runLine("cd #favorites", shuttleIn(), addressed("/Board")),
          ),
        ).toBe(
          '"Board" is not a slug: a slug is lowercase letters, numbers, and ' +
            "single hyphens between words.",
        );
      });

      it("refuses a target the wish matched nothing for, carrying the wish's own error", async () => {
        const outcome = await runLine(
          "cd #profile",
          shuttleIn(),
          wishing(null, "no profile yet"),
        );
        expect(reasonOf(outcome)).toBe(
          "`#profile` resolved to nothing: no profile yet",
        );
      });

      it("refuses a target the wish matched nothing for and said nothing about", async () => {
        expect(
          reasonOf(await runLine("cd #profile", shuttleIn(), wishing(null))),
        ).toBe("`#profile` resolved to nothing.");
      });
    });

    describe("a space written as a name", () => {
      // One connection serves one space, so all a reference naming a space can
      // want to know is whether it names this one. The connection records the
      // name it was opened under, which answers that; nothing here derives a
      // DID from a name, and the cases stand a controller in rather than a
      // derivation.

      it("lands where the reference names once the name is this shuttle's own", async () => {
        const shuttle = shuttleIn();
        const outcome = await runLine(
          `cd /@${SPACE_NAME}/${HANDLE}/title`,
          shuttle,
          settling({ title: "t" }),
        );
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: HANDLE,
          path: ["title"],
        });
      });

      it("refuses a name that is not the one this shuttle was opened under", async () => {
        const shuttle = shuttleIn();
        const outcome = await runLine(
          `cd /@estuary/${HANDLE}`,
          shuttle,
          READS_NOTHING,
        );
        expect(reasonOf(outcome)).toBe(
          "`estuary` is not the space this shuttle is connected to, which " +
            "is `board`. One connection serves one space, so reaching that " +
            "cell means a shuttle started against `estuary`.",
        );
        expect(shuttle.place.place.position.kind).toBe("root");
      });

      it("refuses any name where the connection recorded none, and says what would answer", async () => {
        // A session opened by a DID recorded no name, so whether one names
        // this space is a question the connection cannot answer and the
        // refusal is the honest arm rather than an error path.
        const outcome = await runLine(
          `cd /@${SPACE_NAME}/${HANDLE}`,
          shuttleIn(controller(undefined)),
          READS_NOTHING,
        );
        expect(reasonOf(outcome)).toBe(
          "This shuttle names its space by DID, so it cannot say whether " +
            "`board` is that space. One connection serves one space, and a " +
            "shuttle started against `board` by name is what reaches that " +
            "cell.",
        );
      });

      it("compares the name the reference carried, not the piece it named", async () => {
        const shuttle = shuttleIn(controller(HANDLE));
        expect(
          reasonOf(
            await runLine(
              `cd /@${SPACE_NAME}/${HANDLE}`,
              shuttle,
              READS_NOTHING,
            ),
          ),
        )
          .toBe(
            "`board` is not the space this shuttle is connected to, which " +
              `is \`${HANDLE}\`. One connection serves one space, so ` +
              "reaching that cell means a shuttle started against `board`.",
          );
      });

      it("compares a name whose separator the reference wrote as `~1` against the one it stands for", async () => {
        // The reference reading unescapes before this comparison sees the
        // name, so a name holding the separator arrives in the form the
        // connection recorded rather than in the form it was written.
        const shuttle = shuttleIn(controller("east/west"));
        const outcome = await runLine(
          `cd /@east~1west/${HANDLE}`,
          shuttle,
          settling(null),
        );
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
      });

      it("refuses a name differing from this shuttle's only in case", async () => {
        // Exact, because the key a named space hangs off is derived from the
        // name's bytes: two spellings that differ at all are two spaces.
        const shuttle = shuttleIn(controller("Board"));
        expect(
          reasonOf(
            await runLine(`cd /@board/${HANDLE}`, shuttle, READS_NOTHING),
          ),
        ).toBe(
          "`board` is not the space this shuttle is connected to, which is " +
            "`Board`. One connection serves one space, so reaching that cell " +
            "means a shuttle started against `board`.",
        );
      });

      it("lands the space the connection settled on, which the place then checks", async () => {
        // What the name is held against is the connection's record, and what
        // the place is landed with is the connection's own space — so a
        // connection whose session settled somewhere other than where shuttle
        // stands is refused by the place rather than followed. Nothing puts
        // the two out of step today; the check is the place's own, and this is
        // the door it is reachable through.
        const shuttle = shuttleIn(controller(SPACE_NAME, OTHER_SPACE));
        expect(
          reasonOf(
            await runLine(
              `cd /@${SPACE_NAME}/${HANDLE}`,
              shuttle,
              READS_NOTHING,
            ),
          ),
        ).toBe(
          "`board` resolves to space `did:key:z6MkHomeSpace`, and this " +
            "shuttle is connected to `did:key:z6MkConnectedSpace`. One " +
            "connection serves one space, so reaching that cell means a " +
            "shuttle started against that space.",
        );
      });
    });
  });

  describe("ls", () => {
    it("returns the listing at the place, rendered", async () => {
      expect(await runLine("ls", atPiece(), cellKeys(["title", "body"])))
        .toEqual({
          kind: "text",
          text: "title\nbody",
        });
    });

    it("lists where shuttle stands rather than where it started", async () => {
      const shuttle = shuttleIn();
      moved(shuttle.place, "pieces");
      let listed = 0;
      await runLine("ls", shuttle, {
        ...READS_NOTHING,
        listing: {
          ...READS_NOTHING.listing,
          listPieces: () => {
            listed++;
            return Promise.resolve([{ id: HANDLE }]);
          },
        },
      });
      expect(listed).toBe(1);
    });

    it("raises what a read that failed outright raised", async () => {
      await expect(runLine("ls", atPiece(), READS_NOTHING)).rejects.toThrow(
        "The cell was listed.",
      );
    });
  });

  describe("pwd", () => {
    it("returns both halves of the place, the scope written even at the base", async () => {
      expect(await runLine("pwd", atPiece("title"), READS_NOTHING)).toEqual({
        kind: "text",
        text: `position  /@${SPACE}/${HANDLE}@space/title\nscope     @space`,
      });
    });
  });

  describe("where", () => {
    it("returns every dimension of the ambient record, the connection's first", async () => {
      expect(await runLine("where", atPiece("title"), READS_NOTHING)).toEqual({
        kind: "text",
        text: `api       ${CONFIG.apiUrl}\n` +
          `identity  ${CONFIG.identity}\n` +
          `space     ${SPACE}\n` +
          `position  /@${SPACE}/${HANDLE}@space/title\n` +
          "scope     @space",
      });
    });

    it("returns the place's dimensions written exactly as `pwd` writes them", async () => {
      // What makes the two one format rather than two that agree today: the
      // dimensions `pwd` prints are the end of what `where` prints, character
      // for character.

      const shuttle = atPiece("title");
      const whole = await runLine("where", shuttle, READS_NOTHING);
      const place = await runLine("pwd", shuttle, READS_NOTHING);
      expect(whole.kind === "text" && place.kind === "text").toBe(true);
      expect(textOf(whole).endsWith(`\n${textOf(place)}`)).toBe(true);
    });

    it("returns the record over a connection that will not open", async () => {
      // Nothing here reads, and this is what that is worth: a shuttle whose
      // server has gone away can still say what it was connected as and where
      // it stands.

      const shuttle: Shuttle = {
        config: CONFIG,
        place: new CurrentPlace(SPACE),
        connection: new HeldConnection({
          kind: "owned",
          record: CONFIG,
          open: () => Promise.reject(new Error("The server refused.")),
        }),
      };
      expect(textOf(await runLine("where", shuttle, READS_NOTHING)))
        .toBe(
          `api       ${CONFIG.apiUrl}\n` +
            `identity  ${CONFIG.identity}\n` +
            `space     ${SPACE}\n` +
            `position  @${SPACE}/\n` +
            "scope     @space",
        );
    });

    it("returns the space the connection names beside the one the place settled on", async () => {
      // The two dimensions carry different things and both are worth seeing:
      // a person names a space and the fabric answers with a DID, and the
      // record shows the naming as well as what it denotes.

      const shuttle: Shuttle = {
        config: { ...CONFIG, space: SPACE_NAME },
        place: new CurrentPlace(SPACE),
        connection: new HeldConnection({ kind: "borrowed", pieces: PIECES }),
      };
      expect(textOf(await runLine("where", shuttle, READS_NOTHING))).toContain(
        `space     ${SPACE_NAME}\nposition  @${SPACE}/`,
      );
    });

    it("returns the connection's own values shown as a message is shown", async () => {
      // The three arrive from a launch flag or the environment behind it, so
      // no door has held them to the class a terminal acts on. They are prose
      // somebody reads, which is the glyph rather than the JSON escape.

      const shuttle: Shuttle = {
        config: { ...CONFIG, space: "boa\u009brd", identity: "/k\u007fey" },
        place: new CurrentPlace(SPACE),
        connection: new HeldConnection({ kind: "borrowed", pieces: PIECES }),
      };
      const text = textOf(await runLine("where", shuttle, READS_NOTHING));
      expect(text).toContain("space     boa␦rd");
      expect(text).toContain("identity  /k␡ey");
      expect(/\p{Cc}/u.test(text.replaceAll("\n", ""))).toBe(false);
    });
  });

  describe("get", () => {
    it("returns the value at the cell where shuttle stands", async () => {
      expect(await runLine("get", atPiece(), cellValue({ title: "a" })))
        .toEqual(
          { kind: "value", value: { title: "a" } },
        );
    });

    it("reads the piece the place stands on", async () => {
      // A slug stands unresolved in the place, so what a read is handed is the
      // slug — the same thing a listing hands on, and what makes a name typed
      // back off one reach the piece it names.
      const shuttle = shuttleIn();
      moved(shuttle.place, "slugs");
      moved(shuttle.place, "board");
      let config: PieceConfig | undefined;
      await runLine("get", shuttle, {
        ...READS_NOTHING,
        getCellValue: (given) => {
          config = given;
          return Promise.resolve(null);
        },
      });
      expect(config?.piece).toBe("board");
    });

    it("reads at the scope the place reads through", async () => {
      const shuttle = atPiece();
      moved(shuttle.place, ".@session");
      let config: PieceConfig | undefined;
      await runLine("get", shuttle, {
        ...READS_NOTHING,
        getCellValue: (given) => {
          config = given;
          return Promise.resolve(null);
        },
      });
      expect(config?.pieceScope).toBe("session");
    });

    it("reads at the path inside the piece the place stands at", async () => {
      let path: (string | number)[] | undefined;
      await runLine("get", atPiece("topics", "3"), {
        ...READS_NOTHING,
        getCellValue: (_config, given) => {
          path = given;
          return Promise.resolve(null);
        },
      });
      expect(path).toEqual(["topics", 3]);
    });

    it("reads without starting the piece", async () => {
      // A computed value is as fresh as the last thing that ran the pattern,
      // and this read is not one: it asks for what the piece serves rather
      // than stepping it first.
      let options: GetCellValueOptions | undefined;
      await runLine("get", atPiece(), {
        ...READS_NOTHING,
        getCellValue: (_config, _path, given) => {
          options = given;
          return Promise.resolve(null);
        },
      });
      expect(options?.step).toBeUndefined();
    });

    it("hands the read the connection this process holds", async () => {
      let loaded: unknown;
      await runLine("get", atPiece(), {
        ...READS_NOTHING,
        getCellValue: async (config, _path, _options, deps) => {
          loaded = await deps?.loadPieces?.(config);
          return null;
        },
      });
      expect(loaded).toBe(PIECES);
    });

    it("reads the cell an operand names, from where shuttle stands", async () => {
      let path: (string | number)[] | undefined;
      await runLine("get topics/3", atPiece(), {
        ...READS_NOTHING,
        getCellValue: (_config, given) => {
          path = given;
          return Promise.resolve(null);
        },
      });
      expect(path).toEqual(["topics", 3]);
    });

    it("reads through `..` the level `cd ..` moves to", async () => {
      // The trail and not the levels: standing at a piece reached through
      // `slugs/`, `..` is the facet it was reached through rather than the
      // space root the piece also sits directly inside. Both doors read the
      // operand from where shuttle actually stands, which is what makes the
      // two agree.

      const shuttle = shuttleIn();
      moved(shuttle.place, "slugs");
      moved(shuttle.place, "board");
      const refused = await runLine("get ..", shuttle, READS_NOTHING);
      expect(reasonOf(refused)).toBe(
        "`slugs/` is a list of what stands inside it rather than a cell, so " +
          "it holds no value. `ls` lists it.",
      );
      expect(await runLine("cd ..", shuttle, READS_NOTHING)).toEqual({
        kind: "moved",
        place: shuttle.place.place,
      });
      expect(shuttle.place.place.position).toEqual({
        kind: "facet",
        space: SPACE,
        facet: "slugs",
      });
    });

    it("moves nowhere reading the cell an operand names", async () => {
      const shuttle = atPiece();
      const before = shuttle.place.place;
      await runLine("get topics", shuttle, cellValue(null));
      expect(shuttle.place.place).toBe(before);
    });

    it("refuses a space root, naming what lists it", async () => {
      expect(reasonOf(await runLine("get", shuttleIn(), READS_NOTHING))).toBe(
        "A space root is a list of what stands inside it rather than a cell, " +
          "so it holds no value. `ls` lists it.",
      );
    });

    it("refuses a facet, naming it", async () => {
      const shuttle = shuttleIn();
      moved(shuttle.place, "pieces");
      expect(reasonOf(await runLine("get", shuttle, READS_NOTHING))).toBe(
        "`pieces/` is a list of what stands inside it rather than a cell, so " +
          "it holds no value. `ls` lists it.",
      );
    });

    it("refuses a `#name` target, naming the verb that reads one", async () => {
      expect(
        reasonOf(await runLine("get #favorites", atPiece(), READS_NOTHING)),
      ).toBe(
        "`#favorites` names an entry point rather than a cell under this " +
          "place. `wish #favorites` reads what it resolves to.",
      );
    });

    it("settles a space written as a name, and reads where it names", async () => {
      let config: PieceConfig | undefined;
      const outcome = await runLine(
        `get /@${SPACE_NAME}/${HANDLE}/title`,
        shuttleIn(),
        {
          ...READS_NOTHING,
          getCellValue: (given) => {
            config = given;
            return Promise.resolve("read");
          },
        },
      );
      expect(outcome).toEqual({ kind: "value", value: "read" });
      expect(config?.piece).toBe(HANDLE);
    });

    it("moves nowhere settling a space written as a name", async () => {
      const shuttle = shuttleIn();
      const before = shuttle.place.place;
      await runLine(`get /@${SPACE_NAME}/${HANDLE}`, shuttle, cellValue(null));
      expect(shuttle.place.place).toBe(before);
    });

    describe("the `#argument` suffix", () => {
      // Standing in an arguments cell is what a result-rooted place cannot do,
      // and reading one is a different act — `cf cell get` performs it, and
      // `grammar.md` spells it `get topics/3#argument`. So `get`'s door is
      // `cd`'s plus this suffix, and each case names which of the two cells
      // the read was aimed at.

      /** Helper for the cases below, which is what `line` read, and where. */
      async function reads(
        shuttle: Shuttle,
        line: string,
      ): Promise<
        { config?: PieceConfig; path?: (string | number)[]; input?: boolean }
      > {
        const seen: {
          config?: PieceConfig;
          path?: (string | number)[];
          input?: boolean;
        } = {};
        await runLine(line, shuttle, {
          ...READS_NOTHING,
          getCellValue: (config, path, options) => {
            seen.config = config;
            seen.path = path;
            seen.input = options?.input;
            return Promise.resolve(null);
          },
        });
        return seen;
      }

      it("reads the result cell for an operand carrying no suffix", async () => {
        expect((await reads(atPiece(), "get title")).input).toBe(false);
      });

      it("reads the arguments cell for an operand ending in the suffix", async () => {
        expect((await reads(atPiece(), "get title#argument")).input).toBe(true);
      });

      it("reads the arguments cell at the path the operand names", async () => {
        const seen = await reads(atPiece("topics"), "get 3#argument");
        expect(seen.path).toEqual(["topics", 3]);
        expect(seen.input).toBe(true);
      });

      it("reads the arguments cell a bare piece designation selects", async () => {
        const shuttle = shuttleIn();
        moved(shuttle.place, "slugs");
        const seen = await reads(shuttle, "get board#argument");
        expect(seen.config?.piece).toBe("board");
        expect(seen.path).toEqual([]);
        expect(seen.input).toBe(true);
      });

      it("reads the arguments cell a rooted reference selects", async () => {
        const seen = await reads(shuttleIn(), `get /${HANDLE}/title#argument`);
        expect(seen.config?.piece).toBe(HANDLE);
        expect(seen.path).toEqual(["title"]);
        expect(seen.input).toBe(true);
      });

      it("reads a `#` inside a piece as a character of a key", async () => {
        expect((await reads(atPiece(), "get a#b")).path).toEqual(["a#b"]);
      });

      it("refuses the suffix written with nothing in front of it", async () => {
        expect(
          reasonOf(await runLine("get #argument", atPiece(), READS_NOTHING)),
        ).toBe(
          "`#argument` selects a piece's arguments cell, so it follows the " +
            "target it selects, as in `get topics#argument`.",
        );
      });
    });

    it("refuses a space written as a name that is not this shuttle's own", async () => {
      const outcome = await runLine(
        `get /@estuary/${HANDLE}`,
        shuttleIn(),
        READS_NOTHING,
      );
      expect(reasonOf(outcome)).toBe(
        "`estuary` is not the space this shuttle is connected to, which is " +
          "`board`. One connection serves one space, so reaching that cell " +
          "means a shuttle started against `estuary`.",
      );
    });

    it("raises what a read that failed raised", async () => {
      await expect(runLine("get", atPiece(), READS_NOTHING)).rejects.toThrow(
        "A cell was read.",
      );
    });
  });

  describe("wish", () => {
    // Reading across spaces costs nothing, where standing in one is what a
    // single connection cannot do, so the refusal decision 5 carries is `cd`'s
    // and this verb has none. No case here shows that: what `readWish` answers
    // a value read with says nothing about the space it resolved in, so the
    // absent check has nothing to be seen against.

    it("returns the value the target resolved to", async () => {
      expect(
        await runLine("wish #profileName", shuttleIn(), wishing("Ada")),
      ).toEqual({ kind: "value", value: "Ada" });
    });

    it("returns a resolved object with its handles written as markers", async () => {
      // A resolved object carries its pattern's stream handles, and through
      // them the runtime's whole object graph. The walk that strips them is
      // `cf wish`'s own, so what a target answers here is what it answers
      // there.
      expect(
        await runLine(
          "wish #profile",
          shuttleIn(),
          wishing({
            name: "Ada",
            setName: () => {},
          }),
        ),
      ).toEqual({
        kind: "value",
        value: { name: "Ada", setName: "[stream:setName]" },
      });
    });

    it("asks the wish for the target's value rather than for its address", async () => {
      let asked: WishReadConfig | undefined;
      await runLine("wish #profile", shuttleIn(), {
        ...READS_NOTHING,
        readWish: (config) => {
          asked = config;
          return Promise.resolve({ result: null });
        },
      });
      expect(asked?.query).toBe("#profile");
      expect(asked?.selection).toBeUndefined();
    });

    it("hands the wish the connection this process holds", async () => {
      let loaded: unknown;
      await runLine("wish #profile", shuttleIn(), {
        ...READS_NOTHING,
        readWish: async (config, deps) => {
          loaded = await deps?.loadPieces?.(config);
          return { result: null };
        },
      });
      expect(loaded).toBe(PIECES);
    });

    it("refuses a target that matched nothing, carrying the wish's own error", async () => {
      expect(
        reasonOf(
          await runLine(
            "wish #profile",
            shuttleIn(),
            wishing(null, "no profile yet"),
          ),
        ),
      ).toBe("`#profile` resolved to nothing: no profile yet");
    });

    it("returns the null a target that matched nothing else answers with", async () => {
      expect(
        await runLine("wish #profile", shuttleIn(), wishing(null)),
      ).toEqual({ kind: "value", value: null });
    });
  });

  describe("a line the prompt cancelled", () => {
    // What an `AbortSignal` on the deps bag buys, which is a check at each
    // boundary between a verb's phases rather than anything that reaches a
    // read already sent. Two properties follow and both are pinned here: a
    // cancelled line sends no read it had not sent, and it adopts no place.
    //
    // `cd` is the verb with boundaries to check, and it has three reads to
    // sit between: the resolution, the handle lookup, and the walk of the
    // path. Every case below aborts from inside one of them, which is where a
    // `ctrl-c` really arrives — while something is in flight. A signal
    // aborted before the line starts is the one case that does not need a
    // read to arrange it.

    /** Helper for the cases below, which is a signal already aborted. */
    function cancelled(): AbortSignal {
      const stopper = new AbortController();
      stopper.abort();
      return stopper.signal;
    }

    /**
     * Every read this module can issue, by the name a case knows it by.
     *
     * It is the whole set rather than a selection, and what closes it is that
     * each is a seam a case stands in for: a read this module makes through
     * anything else is a read no case could have stood in for, which is a
     * different defect and one `READS_NOTHING` catches on every case in this
     * file. The one await that reaches the world and is not here is
     * `connection.pieces()`, which answers off the holder's memo — shuttle
     * opens its connection before the prompt reads its first line
     * (`run.ts`), so within a line it sends nothing.
     */
    const READS = [
      "getCellValue",
      "readWish",
      "resolvePieceReference",
      "listSpaceSlugs",
      "listPieces",
      "listCellKeys",
      "entityIdExists",
    ] as const;

    /** One of {@link READS}. */
    type Read = typeof READS[number];

    /** Where a case puts the cancel. */
    type Cancel =
      /** Inside that read, as it is issued. */
      | Read
      /**
       * The moment the line first gives up control, whatever it was waiting
       * on. A verb runs synchronously to its first `await`, so the abort
       * lands in that window without a case having to name what opens it —
       * which is what lets these cases cover a boundary nobody enumerated.
       */
      | "suspend";

    /** What a cancelled line was seen to do. */
    interface Watched {
      /** Every read it issued, in order. */
      readonly reached: Read[];

      /** Every read it issued after the cancel, which must be none. */
      readonly afterCancel: Read[];
    }

    /**
     * Helper for the cases below, which runs `line` against the shuttle
     * `standing` builds, cancels it at `at`, and returns what it read.
     *
     * Every read is stood in for and every one is counted, so what comes back
     * is the whole of what the line asked the world for. A read is recorded
     * as after the cancel when the signal was already aborted as it was
     * issued — the read that carries the cancel is not one of those, the
     * abort being raised as it is entered rather than before.
     */
    async function cancelling(
      line: string,
      standing: (pieces: PiecesController) => Shuttle,
      at: Cancel,
    ): Promise<Watched> {
      const stopper = new AbortController();
      const reached: Read[] = [];
      const afterCancel: Read[] = [];
      const note = (name: Read) => {
        reached.push(name);
        if (stopper.signal.aborted) afterCancel.push(name);
        if (name === at) stopper.abort();
      };
      const shuttle = standing(
        {
          dispose: () => Promise.resolve(),
          getSpace: () => SPACE,
          getSpaceName: () => SPACE_NAME,
          entityIdExists: () => {
            note("entityIdExists");
            return Promise.resolve(true);
          },
        } as unknown as PiecesController,
      );
      const running = runLine(line, shuttle, {
        getCellValue: () => {
          note("getCellValue");
          return Promise.resolve({ title: "a" });
        },
        readWish: () => {
          note("readWish");
          return Promise.resolve({
            result: { [LINK_MARKER_KEY]: `/${HANDLE}` },
          });
        },
        resolvePieceReference: (_pieces, token, path) => {
          note("resolvePieceReference");
          return Promise.resolve({
            piece: token === "board" ? BOARD : token,
            pathAfter: [...path],
          });
        },
        listing: {
          listSpaceSlugs: () => {
            note("listSpaceSlugs");
            return Promise.resolve([]);
          },
          listPieces: () => {
            note("listPieces");
            return Promise.resolve([]);
          },
          listCellKeys: () => {
            note("listCellKeys");
            return Promise.resolve([]);
          },
        },
        signal: stopper.signal,
      });
      if (at === "suspend") stopper.abort();
      await running;
      return { reached, afterCancel };
    }

    /** Helper for the cases below, which stands at the space root. */
    const atRoot = (pieces: PiecesController) => shuttleIn(pieces);

    /** Helper for the cases below, which stands at the facet `facet`. */
    const atFacet = (facet: string) => (pieces: PiecesController) => {
      const shuttle = shuttleIn(pieces);
      moved(shuttle.place, facet);
      return shuttle;
    };

    /** Helper for the cases below, which stands on a piece. */
    const onPiece = (pieces: PiecesController) => {
      const shuttle = shuttleIn(pieces);
      moved(shuttle.place, `/${HANDLE}`);
      return shuttle;
    };

    /**
     * Every line and cancel these cases drive, which is what closes the claim
     * they make.
     *
     * The claim is a universal — *no* read is issued after a cancel — and the
     * risk in one is a case that samples the boundaries somebody thought of.
     * So the rows are not boundaries at all: each names a read to cancel from
     * inside, or asks for the cancel at the line's first suspension without
     * naming what that is. A boundary nobody enumerated still fails here,
     * provided a row reaches it, and the case below the table is what holds
     * the rows to reaching every read there is.
     */
    const CANCELLED: readonly (readonly [
      string,
      (pieces: PiecesController) => Shuttle,
      Cancel,
    ])[] = [
      ["cd board/title", atFacet("slugs"), "suspend"],
      ["cd board/title", atFacet("slugs"), "resolvePieceReference"],
      ["cd board/title", atFacet("slugs"), "getCellValue"],
      [`cd /${BOARD}/title`, atRoot, "resolvePieceReference"],
      [`cd /${BOARD}/title`, atRoot, "entityIdExists"],
      ["cd #favorites", atRoot, "suspend"],
      ["cd #favorites", atRoot, "readWish"],
      ["cd .@session", onPiece, "suspend"],
      ["get title", onPiece, "suspend"],
      ["get", onPiece, "suspend"],
      ["wish #favorites", atRoot, "suspend"],
      ["ls", atFacet("slugs"), "suspend"],
      ["get title", onPiece, "getCellValue"],
      ["wish #favorites", atRoot, "readWish"],
      ["ls", atFacet("slugs"), "listSpaceSlugs"],
      ["ls", atFacet("pieces"), "listPieces"],
      ["ls", onPiece, "listCellKeys"],
    ];

    it("issues no read after the cancel, on any line and from any read", async () => {
      // The contract's universal half, driven rather than enumerated. Each
      // row is reported with the line and the cancel that produced it, so a
      // row that fails names the boundary that lost its guard rather than
      // leaving the whole table red with nothing said.

      for (const [line, standing, at] of CANCELLED) {
        const watched = await cancelling(line, standing, at);
        expect({ line, at, after: watched.afterCancel })
          .toEqual({ line, at, after: [] });
      }
    });

    /**
     * The verbs that read nothing, and so have no read for a cancel to stop.
     *
     * It is asserted rather than asserted about: the case below runs each
     * with every read standing in as a throw, so a verb listed here that
     * reaches one fails instead of being excused by this list.
     */
    const READS_NOTHING_AT_ALL = ["help", "pwd", "where"];

    it("cancels a line of every verb, or says why the verb has no read", async () => {
      // What closes the set of verbs, which is the gap the rows above had:
      // `wish` and `ls` reach `guarded` with nothing awaited in front of it,
      // so a cancel at the first suspension is the only cancel that can catch
      // a guard that has drifted — and neither had a row.
      //
      // The list is the module's own answer rather than a list kept here: a
      // word that is no verb is refused with the verbs named, so a verb added
      // to the dispatch is a verb this case demands a row for.

      const refusal = await runLine("frob", shuttleIn(), READS_NOTHING);
      const named = [...reasonOf(refusal).matchAll(/`([a-z]+)`/g)]
        .map((found) => found[1])
        .filter((word) => word !== "frob");
      const suspended = CANCELLED
        .filter(([, , at]) => at === "suspend")
        .map(([line]) => line.split(" ")[0]);
      expect([...new Set(named)].sort())
        .toEqual([...new Set([...suspended, ...READS_NOTHING_AT_ALL])].sort());

      // And the excused ones are excused truthfully: every read throws, so a
      // verb that reached one would raise rather than answer.
      for (const verb of READS_NOTHING_AT_ALL) {
        const outcome = await runLine(verb, shuttleIn(), READS_NOTHING);
        expect({ verb, kind: outcome.kind }).toEqual({ verb, kind: "text" });
      }
    });

    it("drives every read there is, which is what closes the case above", async () => {
      // Without this the table would be a sample wearing a universal's
      // words: rows reaching six of the seven reads would pass while the
      // seventh went unguarded. A read added to the module is added to
      // `READS`, and this fails until a row reaches it.

      const reached = new Set<Read>();
      for (const [line, standing, at] of CANCELLED) {
        for (const read of (await cancelling(line, standing, at)).reached) {
          reached.add(read);
        }
      }
      expect([...reached].sort()).toEqual([...READS].sort());
    });

    it("sends no wish where the cancel arrived while the selection parsed", async () => {
      // `resolveTarget` parses the selection `--select @` spells before it
      // sends the wish, and the parse is an await. So a cancel lands in that
      // window, and what it must stop is the read the parse was preparing.

      const watched = await cancelling("cd #favorites", atRoot, "suspend");
      expect(watched.reached).toEqual([]);
    });

    it("resolves no piece where the cancel arrived while the connection was asked for", async () => {
      // The settle asks the holder for the connection before it resolves
      // anything, and that ask is an await of its own. The resolution behind
      // it is a read, so the window the ask opens is a boundary.

      const watched = await cancelling(
        "cd board/title",
        atFacet("slugs"),
        "suspend",
      );
      expect(watched.reached).toEqual([]);
    });

    it("reads no cell where the cancel arrived while the operand was placed", async () => {
      // Where a `get`'s operand points can itself be a read — a space
      // written as a name is asked of the connection — so placing the
      // operand and reading the cell are two phases, and this is the
      // boundary between them.

      const watched = await cancelling("get title", onPiece, "suspend");
      expect(watched.reached).toEqual([]);
    });

    it("runs no verb at all for a line already cancelled", async () => {
      // The check at the dispatch, which is the only one a verb that reads
      // nothing ever meets: `pwd` composes its answer out of what the process
      // is already holding, so no guarded read stands between the cancel and
      // an answer, and without this check a cancelled line would get one.

      expect(
        await runLine("pwd", shuttleIn(), {
          ...READS_NOTHING,
          signal: cancelled(),
        }),
      ).toEqual({ kind: "interrupted" });
    });

    it("sends no read for a line already cancelled", async () => {
      let read = 0;
      const outcome = await runLine("get", atPiece(), {
        ...READS_NOTHING,
        getCellValue: () => {
          read += 1;
          return Promise.resolve(null);
        },
        signal: cancelled(),
      });
      expect(outcome).toEqual({ kind: "interrupted" });
      expect(read).toBe(0);
    });

    it("still refuses a line that was wrong, cancelled or not", async () => {
      // The reading of the words happens before the check, and it is worth
      // making either way: a line that named no verb is not a verb that was
      // interrupted, and telling a person their line was cancelled when it
      // was misspelled would send them back to a line that never could run.

      expect(
        await runLine("frob", shuttleIn(), {
          ...READS_NOTHING,
          signal: cancelled(),
        }),
      ).toEqual({
        kind: "refused",
        reason: "`frob` is not a verb. The verbs are `cd`, `get`, `help`, " +
          "`ls`, `pwd`, `where`, and `wish`.",
      });
    });

    it("walks no path where the cancel arrived during the resolution", async () => {
      // The first boundary a settle has: the resolution has answered and the
      // walk has not been asked for. The slug resolves to a piece other than
      // the one it was spelled as, which is what proves it held — so this
      // move has no lookup between the two, and the check after the
      // resolution is the one that stops the walk.

      const shuttle = shuttleIn();
      moved(shuttle.place, "slugs");
      const stopper = new AbortController();
      let walked = 0;
      const outcome = await runLine("cd board/title", shuttle, {
        ...READS_NOTHING,
        resolvePieceReference: (_pieces, _token, path) => {
          stopper.abort();
          return Promise.resolve({ piece: BOARD, pathAfter: [...path] });
        },
        getCellValue: () => {
          walked += 1;
          return Promise.resolve({ title: "a" });
        },
        signal: stopper.signal,
      });
      expect(outcome).toEqual({ kind: "interrupted" });
      expect(walked).toBe(0);
    });

    it("looks no handle up where the cancel arrived during the resolution", async () => {
      // The lookup's own guard, which the walk's guard would otherwise stand
      // in for: a cancel arriving during the resolution must stop the lookup,
      // not merely the walk behind it. The piece is spelled as a handle, so
      // the resolution proves nothing and the lookup is the read that would
      // have gone out next.

      const shuttle = shuttleIn(lookingUp(true));
      const stopper = new AbortController();
      let looked = 0;
      const outcome = await runLine(`cd /${BOARD}/title`, {
        ...shuttle,
        connection: new HeldConnection({
          kind: "borrowed",
          pieces: {
            dispose: () => Promise.resolve(),
            getSpace: () => SPACE,
            getSpaceName: () => SPACE_NAME,
            entityIdExists: () => {
              looked += 1;
              return Promise.resolve(true);
            },
          } as unknown as PiecesController,
        }),
      }, {
        ...READS_NOTHING,
        resolvePieceReference: (_pieces, token, path) => {
          stopper.abort();
          return Promise.resolve({ piece: token, pathAfter: [...path] });
        },
        signal: stopper.signal,
      });
      expect(outcome).toEqual({ kind: "interrupted" });
      expect(looked).toBe(0);
    });

    it("walks no path where the cancel arrived during the handle lookup", async () => {
      // The second boundary, and the one only a move with a handle to look up
      // reaches: `entityIdExists` has answered and the walk has not been asked
      // for. A handle is a spelling that proves nothing, so this is the move
      // that pays for the lookup — and a lookup is a round trip a person is as
      // likely to be waiting on as any other.

      const shuttle = shuttleIn();
      const stopper = new AbortController();
      let walked = 0;
      const outcome = await runLine(`cd /${BOARD}/title`, {
        ...shuttle,
        connection: new HeldConnection({
          kind: "borrowed",
          pieces: {
            dispose: () => Promise.resolve(),
            getSpace: () => SPACE,
            getSpaceName: () => SPACE_NAME,
            entityIdExists: () => {
              stopper.abort();
              return Promise.resolve(true);
            },
          } as unknown as PiecesController,
        }),
      }, {
        ...READS_NOTHING,
        resolvePieceReference: (_pieces, token, path) =>
          Promise.resolve({ piece: token, pathAfter: [...path] }),
        getCellValue: () => {
          walked += 1;
          return Promise.resolve({ title: "a" });
        },
        signal: stopper.signal,
      });
      expect(outcome).toEqual({ kind: "interrupted" });
      expect(walked).toBe(0);
    });

    it("moves nowhere where the cancel arrived during the last read", async () => {
      // The check before the place is adopted, which is the one that matters:
      // `cd` is the verb whose success means something, and a line the person
      // stopped waiting for must not go on to promise a place.
      //
      // The cancel arrives during the walk, which is the settle's last read
      // and the one no check inside the settle follows — it answers, the path
      // is found, and the settle says the fabric holds the place. So nothing
      // but the check at the adoption stands between this cancel and a move,
      // which is why the case aims here rather than at an earlier read: an
      // earlier one is stopped by a check of its own, and would pass with the
      // adoption unguarded.

      const shuttle = shuttleIn();
      moved(shuttle.place, "slugs");
      const stopper = new AbortController();
      const outcome = await runLine("cd board/title", shuttle, {
        ...READS_NOTHING,
        resolvePieceReference: (_pieces, _token, path) =>
          Promise.resolve({ piece: BOARD, pathAfter: [...path] }),
        getCellValue: () => {
          stopper.abort();
          return Promise.resolve({ title: "a" });
        },
        signal: stopper.signal,
      });
      expect(outcome).toEqual({ kind: "interrupted" });
      expect(shuttle.place.place.position).toEqual({
        kind: "facet",
        space: SPACE,
        facet: "slugs",
      });
    });

    it("changes no scope where the cancel arrived during a scope's own settle", async () => {
      // A scope on its own settles, because a scope selects which document a
      // piece's id names and the place at the new one is a place nothing has
      // read. So it reaches the fabric like any other move onto a piece, and
      // a person waiting on it can stop waiting — and what a cancel has to
      // leave alone here is the scope rather than the position, which is the
      // half of a place the other cases do not assert.

      const shuttle = shuttleIn();
      await runLine(`cd /${HANDLE}/topics`, shuttle, settling({ topics: 1 }));
      const stopper = new AbortController();
      const outcome = await runLine("cd .@session", shuttle, {
        ...settling({ topics: 1 }),
        getCellValue: () => {
          stopper.abort();
          return Promise.resolve({ topics: 1 });
        },
        signal: stopper.signal,
      });
      expect(outcome).toEqual({ kind: "interrupted" });
      expect(shuttle.place.place.scope).toBe("space");
    });

    it("enters no target where the cancel arrived while it was resolving", async () => {
      // The same check on the arm a `#name` target takes: the fabric answered
      // with an address, and the place is not moved into it.

      const shuttle = shuttleIn();
      const stopper = new AbortController();
      const outcome = await runLine("cd #favorites", shuttle, {
        ...READS_NOTHING,
        readWish: () => {
          stopper.abort();
          return Promise.resolve({
            result: { [LINK_MARKER_KEY]: `/${HANDLE}` },
          });
        },
        signal: stopper.signal,
      });
      expect(outcome).toEqual({ kind: "interrupted" });
      expect(shuttle.place.place.position).toEqual({
        kind: "root",
        space: SPACE,
      });
    });

    it("runs the line to the end where nothing cancelled it", async () => {
      // The other side of every case above: a signal that is merely present
      // stops nothing, so what the checks cost a line nobody interrupted is
      // nothing at all.

      const shuttle = shuttleIn();
      moved(shuttle.place, "slugs");
      const outcome = await runLine("cd board", shuttle, {
        ...settling(null, { board: BOARD }),
        signal: new AbortController().signal,
      });
      expect(outcome.kind).toBe("moved");
      expect(shuttle.place.place.position).toEqual({
        kind: "piece",
        space: SPACE,
        piece: BOARD,
        name: "board",
        path: [],
      });
    });
  });
});
