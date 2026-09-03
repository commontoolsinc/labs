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
 * The connection is a borrowed one throughout. No verb opens or closes one, so
 * which arm a case stands it up through decides nothing here, and the borrowed
 * arm is the one that needs no opener behind it.
 *
 * Two properties the file exists for run through it. A read never moves the
 * place, and a move never happens twice, so each of the two verbs that resolve
 * an operand is asked what it left behind as well as what it returned. And
 * nothing here writes: the dispatch hands its outcome back, so a prompt drawing
 * its own screen is never written over from underneath.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { LINK_MARKER_KEY } from "@commonfabric/cli/lib/cell-selection";
import type {
  GetCellValueOptions,
  PieceConfig,
  SpaceConfig,
} from "@commonfabric/cli/lib/piece";
import type { WishReadConfig } from "@commonfabric/cli/lib/wish";
import { createSession, Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { PiecesController } from "@commonfabric/piece/ops";

import { HeldConnection } from "../src/connection.ts";
import { CurrentPlace } from "../src/place.ts";
import {
  type Outcome,
  runLine,
  type Shuttle,
  type VerbDeps,
} from "../src/verbs.ts";

const SPACE = "did:key:z6MkConnectedSpace" as MemorySpace;
const OTHER_SPACE = "did:key:z6MkHomeSpace" as MemorySpace;
const HANDLE = "of:fid1:abcdefghijklmnop";

const CONFIG: SpaceConfig = {
  apiUrl: "https://toolshed.example/",
  space: SPACE,
  identity: "/keys/shuttle.pkcs8",
};

/**
 * Helper for the cases below, which is the controller every shuttle here
 * borrows. Nothing calls anything on it: what a case can see is which read was
 * handed it.
 */
const PIECES = {
  dispose: () => Promise.resolve(),
} as unknown as PiecesController;

/** Helper for the cases below, which fails whichever read a case reaches. */
const READS_NOTHING: VerbDeps = {
  getCellValue: () => {
    throw new Error("A cell was read.");
  },
  readWish: () => {
    throw new Error("A wish was resolved.");
  },
  spaceNamed: () => {
    throw new Error("A space name was derived.");
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

/** Helper for the cases below, which is a shuttle standing at `space`'s root. */
function shuttleIn(space: MemorySpace = SPACE): Shuttle {
  return {
    config: { ...CONFIG, space },
    place: new CurrentPlace(space),
    connection: new HeldConnection({ kind: "borrowed", pieces: PIECES }),
  };
}

/** Helper for the cases below, which stands at a piece, at `path` inside it. */
function atPiece(...path: string[]): Shuttle {
  const shuttle = shuttleIn();
  shuttle.place.cd(`/${HANDLE}`);
  for (const segment of path) shuttle.place.cd(segment);
  return shuttle;
}

/** Helper for the cases below, which stands `value` in for a cell's value. */
function cellValue(value: unknown): VerbDeps {
  return { ...READS_NOTHING, getCellValue: () => Promise.resolve(value) };
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

/** Helper for the cases below, which is the reason `outcome` was refused. */
function reasonOf(outcome: Outcome): string {
  return outcome.kind === "refused"
    ? outcome.reason
    : `not refused: ${outcome.kind}`;
}

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
        reason: "`frob` is not a verb. The verbs are `cd`, `get`, `ls`, " +
          "`pwd`, and `wish`.",
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
            "`ls`, `pwd`, and `wish`.",
        });
      }
    });

    it("returns the reason the split gave a line it would not split", async () => {
      expect(await runLine("get 'a", shuttleIn(), READS_NOTHING)).toEqual({
        kind: "refused",
        reason: "The `'` opened at column 5 is never closed.",
      });
    });

    it("hands the tokens after the verb on as its operands", async () => {
      expect(await runLine("pwd here", shuttleIn(), READS_NOTHING)).toEqual({
        kind: "refused",
        reason: "`pwd` takes no operand, and was given 1.",
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
          spaceNamed: () => Promise.resolve(SPACE),
          listing: { listCellKeys: () => Promise.resolve(["title"]) },
        };
        const shuttle = atPiece();
        for (const line of ["pwd", "ls", "get", "wish #favorites", "cd .."]) {
          await runLine(line, shuttle, answers);
        }
      } finally {
        Deno.stdout.writeSync = stdout;
        Deno.stderr.writeSync = stderr;
      }
      expect(written).toEqual([]);
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

    it("returns the reason a place gave no operand at all", async () => {
      expect(reasonOf(await runLine("cd", shuttleIn(), READS_NOTHING))).toBe(
        "`cd` takes a place to move to.",
      );
    });

    it("refuses two operands", async () => {
      expect(
        reasonOf(await runLine("cd a b", shuttleIn(), READS_NOTHING)),
      ).toBe("`cd` takes one operand, and was given 2.");
    });

    it("refuses an operand ending in `#argument`, a place being result-rooted", async () => {
      // The asymmetry `get`'s own door turns on: `cd` refuses the suffix in
      // every spelling that takes one, and `get` reads it.
      const shuttle = shuttleIn();
      shuttle.place.cd("slugs");
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

      it("refuses a target whose address carries a scope suffix", async () => {
        const outcome = await runLine(
          "cd #favorites",
          shuttleIn(),
          addressed(`/${HANDLE}@session/title`),
        );
        expect(reasonOf(outcome)).toBe(
          "`#favorites` resolved to an address carrying an `@session` " +
            "suffix, which a place reached through a target does not keep: a " +
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
      it("lands where the reference names once the name resolved to the connected space", async () => {
        const shuttle = shuttleIn();
        const outcome = await runLine(`cd /@estuary/${HANDLE}/title`, shuttle, {
          ...READS_NOTHING,
          spaceNamed: (name) =>
            Promise.resolve(name === "estuary" ? SPACE : OTHER_SPACE),
        });
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: HANDLE,
          path: ["title"],
        });
      });

      it("refuses a name that resolved to another space", async () => {
        const shuttle = shuttleIn();
        const outcome = await runLine(`cd /@estuary/${HANDLE}`, shuttle, {
          ...READS_NOTHING,
          spaceNamed: () => Promise.resolve(OTHER_SPACE),
        });
        expect(reasonOf(outcome)).toBe(
          "`estuary` resolves to space `did:key:z6MkHomeSpace`, and this " +
            "shuttle is connected to `did:key:z6MkConnectedSpace`. One " +
            "connection serves one space, so reaching that cell means a " +
            "shuttle started against that space.",
        );
        expect(shuttle.place.place.position.kind).toBe("root");
      });

      it("derives the space a name denotes the way a session derives it", async () => {
        // The one case here with no stub under it. Which space a name denotes
        // is a fact two callers have to agree about — the session that opens
        // one, and shuttle asking whether a name is the space it already
        // holds — so the case asks the session for the answer and the verb for
        // its own. A second derivation living here would agree with itself and
        // say nothing.

        const session = await createSession({
          identity: await Identity.generate(),
          spaceName: "estuary",
        });
        const shuttle = shuttleIn(session.space);
        const outcome = await runLine(
          `cd /@estuary/${HANDLE}`,
          shuttle,
          { ...READS_NOTHING, spaceNamed: undefined },
        );
        expect(outcome).toEqual({ kind: "moved", place: shuttle.place.place });
        expect(shuttle.place.place.position).toEqual({
          kind: "piece",
          space: session.space,
          piece: HANDLE,
          path: [],
        });
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
      shuttle.place.cd("pieces");
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

    it("refuses an operand", async () => {
      expect(reasonOf(await runLine("ls title", atPiece(), READS_NOTHING)))
        .toBe(
          "`ls` takes no operand, and was given 1.",
        );
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

    it("refuses an operand", async () => {
      expect(reasonOf(await runLine("pwd /", shuttleIn(), READS_NOTHING))).toBe(
        "`pwd` takes no operand, and was given 1.",
      );
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
      shuttle.place.cd("slugs");
      shuttle.place.cd("board");
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
      shuttle.place.cd("@session");
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
      shuttle.place.cd("slugs");
      shuttle.place.cd("board");
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
      shuttle.place.cd("pieces");
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
        `get /@estuary/${HANDLE}/title`,
        shuttleIn(),
        {
          ...READS_NOTHING,
          spaceNamed: (name) =>
            Promise.resolve(name === "estuary" ? SPACE : OTHER_SPACE),
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
      await runLine(`get /@estuary/${HANDLE}`, shuttle, {
        ...cellValue(null),
        spaceNamed: () => Promise.resolve(SPACE),
      });
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
        shuttle.place.cd("slugs");
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

    it("refuses a space written as a name that resolved to another space", async () => {
      const shuttle = shuttleIn();
      const outcome = await runLine(`get /@estuary/${HANDLE}`, shuttle, {
        ...READS_NOTHING,
        spaceNamed: () => Promise.resolve(OTHER_SPACE),
      });
      expect(reasonOf(outcome)).toBe(
        "`estuary` resolves to space `did:key:z6MkHomeSpace`, and this " +
          "shuttle is connected to `did:key:z6MkConnectedSpace`. One " +
          "connection serves one space, so reaching that cell means a " +
          "shuttle started against that space.",
      );
    });

    it("raises what a read that failed raised", async () => {
      await expect(runLine("get", atPiece(), READS_NOTHING)).rejects.toThrow(
        "A cell was read.",
      );
    });

    it("refuses two operands", async () => {
      expect(reasonOf(await runLine("get a b", atPiece(), READS_NOTHING))).toBe(
        "`get` takes one operand, and was given 2.",
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

    it("refuses a line naming no target", async () => {
      expect(reasonOf(await runLine("wish", shuttleIn(), READS_NOTHING))).toBe(
        "`wish` takes the target to resolve, as in `wish #favorites`.",
      );
    });

    it("refuses two operands", async () => {
      expect(
        reasonOf(await runLine("wish #a #b", shuttleIn(), READS_NOTHING)),
      ).toBe("`wish` takes one operand, and was given 2.");
    });
  });
});
