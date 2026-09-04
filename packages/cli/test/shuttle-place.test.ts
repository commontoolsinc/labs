/**
 * Unit tests for the place value and the module that owns it. A place is a
 * value and every move over it is a decision about one, so a case stands a
 * `CurrentPlace` somewhere, hands `cd` a string, and reads back both what the
 * move returned and where the instance ended up. No connection, no I/O and no
 * clock stands behind any of it, which is what makes a case per move, per
 * rendering and per refusal affordable.
 *
 * The returned outcome is the half to read first, because only two of the
 * four arms a `Move` has are verdicts: the move landed, or it is refused. The
 * other two report that the operand is one this module does not settle — a
 * `#name` wish target, and a reference naming its space by name — since
 * settling either needs a connection to resolve against. Their cases pin what
 * gets handed on, and that the place did not move.
 *
 * A refusal's text is pinned whole, and four of them are somebody else's
 * words. Shuttle consumes the reference grammar rather than forking it, so a
 * rooted operand's diagnostics come from that layer and reach the reader
 * unaltered — the space-mismatch sentence and the unknown-suffix sentence from
 * `normalizeLLMFriendlyRef` and `splitArgumentSuffix`, the no-piece-handle
 * sentence from `parseReferenceParts`, and the not-a-slug sentence from
 * `validatePieceSegment`, which every door relays and not the reference alone.
 * Each is marked at its case as relayed.
 * When one moves upstream, the fix is to copy the new sentence here, never to
 * match a fragment of it: the whole sentence is what pins that the diagnostic
 * arrives intact, and a substring would let a rewording through that says
 * something else. Other diagnostics from that layer reach a reader without a
 * case here — a bad space segment, a piece segment that is no handle and holds
 * a colon, a bad scope suffix on a reference — and pinning four of them is
 * enough to hold the relay itself, since all of them travel the same path.
 *
 * Every other refusal in this file is shuttle's own, and two of those
 * deliberately mirror the canonical wording so the two surfaces read as one
 * — those move by choice rather than by upstream drift.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { CellScope } from "@commonfabric/api";
import type { MemorySpace } from "@commonfabric/memory/interface";

import {
  CurrentPlace,
  FACETS,
  type Move,
  operandForChild,
  placeAtSpaceRoot,
} from "../lib/shuttle/place.ts";
import { RECORD_LABEL_WIDTH } from "../lib/shuttle/record.ts";

const SPACE = "did:key:z6MkConnectedSpace" as MemorySpace;
const OTHER_SPACE = "did:key:z6MkOtherSpace" as MemorySpace;
const HANDLE = "of:fid1:abcdefghijklmnop";

/** Helper for the cases below, which stands an instance at the space root. */
function atSpaceRoot(): CurrentPlace {
  return new CurrentPlace(SPACE);
}

/** Helper for the cases below, which stands an instance inside `slugs/`. */
function inSlugs(): CurrentPlace {
  const place = atSpaceRoot();
  place.cd("slugs");
  return place;
}

/**
 * Helper for the cases below, which reads the position `pwd` printed.
 *
 * It slices the width the format exports rather than the label it happens to
 * write, so a change to either moves this with it.
 */
function printedPosition(place: CurrentPlace): string {
  const [position] = place.render().split("\n");
  return position.slice(RECORD_LABEL_WIDTH);
}

/** Helper for the cases below, which stands an instance at a named piece. */
function atReferencedPiece(): CurrentPlace {
  const place = atSpaceRoot();
  place.cd(`/${HANDLE}`);
  return place;
}

/** Helper for the cases below, which stands an instance at a piece. */
function atPiece(): CurrentPlace {
  const place = inSlugs();
  place.cd("board");
  return place;
}

describe("place", () => {
  describe("FACETS", () => {
    it("holds `slugs` and `pieces`, and nothing else", () => {
      expect(FACETS).toEqual(["slugs", "pieces"]);
    });
  });

  describe("placeAtSpaceRoot()", () => {
    it("returns the space's root read at the base scope", () => {
      expect(placeAtSpaceRoot(SPACE)).toEqual({
        position: { kind: "root", space: SPACE },
        scope: "space",
      });
    });
  });

  describe("operandForChild()", () => {
    // The readings `cd()` applies, asked in the other direction. A name whose
    // own characters are not readings is its own operand; one whose characters
    // are is reached by the reference the child renders as, which reads none of
    // them; and a child no rendering names back is reached by neither.
    //
    // Two clauses of the comparison behind it have no case, and both are
    // unreachable from this door rather than untested. Neither spelling tried
    // moves the scope: the reference is rendered carrying the place's own, and
    // the one reading that moves a scope takes a piece segment's suffix with
    // it, which moves the piece too and fails the position clause first. And a
    // space root's children are a closed set, checked before a candidate is
    // tried, so a candidate that lands on a facet lands on the facet named.
    // The comparison is over the whole place because a place is one, and an
    // operand landing anywhere else would name another cell; this paragraph is
    // read again if either clause becomes reachable.

    it("returns the name itself for a key the name's own reading names", () => {
      expect(operandForChild(atReferencedPiece().place, "title")).toBe("title");
    });

    it("returns a facet's own name at a space root", () => {
      expect(operandForChild(placeAtSpaceRoot(SPACE), "slugs")).toBe("slugs");
    });

    it("returns nothing at a space root for a name it lists no facet under", () => {
      expect(operandForChild(placeAtSpaceRoot(SPACE), "fuse")).toBeUndefined();
    });

    it("returns a piece's own name inside a facet", () => {
      expect(operandForChild(inSlugs().place, "board")).toBe("board");
    });

    it("returns a reference for a key called `..`", () => {
      expect(operandForChild(atReferencedPiece().place, "..")).toBe(
        `/@${SPACE}/${HANDLE}@space/..`,
      );
    });

    it("returns a reference escaping a key that holds the separator", () => {
      expect(operandForChild(atReferencedPiece().place, "a/b")).toBe(
        `/@${SPACE}/${HANDLE}@space/a~1b`,
      );
    });

    it("returns nothing for a key no rendering names back", () => {
      expect(operandForChild(atReferencedPiece().place, "a ")).toBeUndefined();
    });

    it("returns nothing for a key whose first character opens a wish target", () => {
      expect(operandForChild(atReferencedPiece().place, "#b")).toBeUndefined();
    });

    it("returns nothing for a piece name in neither vocabulary", () => {
      expect(operandForChild(inSlugs().place, "Board")).toBeUndefined();
    });

    it("returns an operand `cd` moves to the child by", () => {
      const place = atReferencedPiece();
      const operand = operandForChild(place.place, "..");
      expect(operand).toBeDefined();
      place.cd(operand as string);
      expect(place.place.position).toEqual({
        kind: "piece",
        space: SPACE,
        piece: HANDLE,
        path: [".."],
      });
    });
  });

  describe("render()", () => {
    it("returns a space root with no leading slash, and the scope", () => {
      expect(atSpaceRoot().render()).toBe(
        "position  @did:key:z6MkConnectedSpace/\nscope     @space",
      );
    });

    it("returns a facet with no leading slash", () => {
      expect(inSlugs().render()).toBe(
        "position  @did:key:z6MkConnectedSpace/slugs/\nscope     @space",
      );
    });

    it("returns a piece and its path as a fully qualified reference", () => {
      const place = atPiece();
      place.cd("topics/3");
      place.cd("@session");
      expect(place.render()).toBe(
        "position  /@did:key:z6MkConnectedSpace/board@session/topics/3\n" +
          "scope     @session",
      );
    });

    describe("round-tripping", () => {
      // What a reader copies whole has to name the place it was printed
      // for, or name nothing. A piece is a cell, so its rendering is a
      // reference and `cd` takes it back; a container is not a cell, so its
      // rendering is not a reference and `cd` refuses it rather than
      // resolving it to a piece whose slug happens to match the container's
      // name. A segment lifted out of a rendering is outside that, for two
      // reasons: it becomes an operand in its own right, so the head
      // readings decide it, and the rendering escapes a `/` in a key where
      // a relative operand reads no escape. The walk's own cases pin both.

      it("returns a piece rendering `cd` takes back to the same place, pasted whole", () => {
        const place = atPiece();
        place.cd("topics/3");
        const elsewhere = atSpaceRoot();
        elsewhere.cd(printedPosition(place));
        expect(elsewhere.place).toEqual(place.place);
      });

      it("escapes a `/` in a key, and takes that rendering back whole", () => {
        const place = atSpaceRoot();
        place.cd(`/${HANDLE}/a~1b`);
        const printed = printedPosition(place);
        expect(printed).toBe(
          "/@did:key:z6MkConnectedSpace/of:fid1:abcdefghijklmnop@space/a~1b",
        );
        const elsewhere = atSpaceRoot();
        elsewhere.cd(printed);
        expect(elsewhere.place).toEqual(place.place);
      });

      it("returns a rendering `cd` refuses where a key holds a `#`", () => {
        const place = atReferencedPiece();
        place.cd("a#b");
        const elsewhere = atSpaceRoot();
        expect(elsewhere.cd(printedPosition(place)).kind).toBe("refused");
        expect(elsewhere.place).toEqual(placeAtSpaceRoot(SPACE));
      });

      describe("over a constructed set of awkward parts", () => {
        // Five findings in this class arrived one at a time, each from
        // driving a value nobody had listed. This drives a construction and
        // asserts the property rather than the outcomes: a rendering may be
        // refused, but it may never name a cell other than the one it was
        // printed for.
        //
        // What it varies is as load-bearing as the property. A construction
        // that holds a component fixed checks a slice and reads like a
        // class, which is how a piece went unguarded while every path was
        // covered. So both parts a position spells vary, the empty value is
        // a candidate in its own right rather than something the shapes
        // happen not to reach, and every door that admits a position is
        // driven.
        //
        // Held fixed, and why: the space, which one connection settles and
        // no operand supplies, and the facet, which is a fixed set of
        // literals.
        // Everything else varies, and varies crosswise: both parts a
        // position spells, each driven through every door in the table
        // below, at each of the three scopes. Reading back stands at a
        // scope of its
        // own, so the comparison sees whether the rendering carried the
        // scope or the reader supplied it.

        const MARKS = [
          " ",
          "\t",
          "\n",
          "\r",
          "\v",
          "\f",
          "\u00a0",
          "\u2028",
          "\u2029",
          "/",
          "~",
          "#",
          "@",
          "-",
          ".",
        ];

        /**
         * Helper for the case below, which is every awkward spelling of a
         * part whose ordinary spelling is `head` followed by `tail`.
         */
        function candidates(head: string, tail: string): string[] {
          // The digit spellings sit here rather than among the marks: what
          // they exercise is the conversion a path segment goes through,
          // where a canonical index becomes a number and everything else
          // stays a string, and a door that skips it disagrees with the
          // three that do not.
          const values = ["", "3", "0", "01", "1e21", "-1", "1.5"];
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

        it("never renders a place that reads back as a different one", () => {
          let readBack = 0;
          let refusedPart = 0;
          let refusedRendering = 0;

          /**
           * Helper for this case, which holds the property over `place`,
           * reading its rendering back from `reader` — a scope the place is
           * not at, so a rendering that omitted the scope would be filled
           * with the wrong one rather than silently the right one.
           */
          function check(place: CurrentPlace, move: Move, reader: CellScope) {
            if (move.kind !== "moved") {
              refusedPart++;
              return;
            }
            const elsewhere = atSpaceRoot();
            elsewhere.cd(`@${reader}`);
            if (elsewhere.cd(printedPosition(place)).kind !== "moved") {
              refusedRendering++;
              return;
            }
            readBack++;
            expect(elsewhere.place).toEqual(place.place);
          }

          const scopes: CellScope[] = ["space", "user", "session"];

          // The matrix. A door is driven for every component rather than
          // for whichever one its loop happened to sit in — that asymmetry
          // is how `settle` kept an unnormalized path while every other
          // door normalized, in a block whose comment claimed all four.
          const doors: {
            door: string;
            piece: (at: CurrentPlace, value: string) => Move;
            segment: (at: CurrentPlace, value: string) => Move;
          }[] = [
            {
              door: "enter",
              piece: (at, v) =>
                at.enter({ space: SPACE, piece: v, path: [] }, "#x"),
              segment: (at, v) =>
                at.enter({ space: SPACE, piece: HANDLE, path: [v] }, "#x"),
            },
            {
              door: "settle",
              piece: (at, v) =>
                at.settle({
                  kind: "space-by-name",
                  name: "estuary",
                  piece: v,
                  path: [],
                  scope: at.place.scope,
                }, SPACE),
              segment: (at, v) =>
                at.settle({
                  kind: "space-by-name",
                  name: "estuary",
                  piece: HANDLE,
                  path: [v],
                  scope: at.place.scope,
                }, SPACE),
            },
            {
              door: "walk",
              piece: (at, v) => (at.cd("slugs"), at.cd(v)),
              segment: (at, v) => (at.cd(`/${HANDLE}`), at.cd(v)),
            },
            {
              door: "reference",
              piece: (at, v) => at.cd(`/${v}`),
              segment: (at, v) => at.cd(`/${HANDLE}/${v}`),
            },
          ];

          const pieces = candidates(HANDLE.slice(0, 10), HANDLE.slice(10));
          const segments = candidates("b", "c");
          for (const [index, scope] of scopes.entries()) {
            const reader = scopes[(index + 1) % scopes.length];

            /** Helper for this case, which stands at `scope` to begin with. */
            const standing = (): CurrentPlace => {
              const place = atSpaceRoot();
              place.cd(`@${scope}`);
              return place;
            };

            for (const { piece, segment } of doors) {
              for (const value of pieces) {
                const at = standing();
                check(at, piece(at, value), reader);
              }
              for (const value of segments) {
                const at = standing();
                check(at, segment(at, value), reader);
              }
            }
            // A segment reached past another one, which is the only shape
            // the single-segment drives above cannot make.
            for (const value of segments) {
              for (const path of [[value, "tail"], ["head", value]]) {
                const at = standing();
                check(
                  at,
                  at.enter({ space: SPACE, piece: HANDLE, path }, "#x"),
                  reader,
                );
              }
            }
          }

          // Every outcome has to occur, or the property above holds for want
          // of anything to hold over.
          expect(readBack).toBeGreaterThan(0);
          expect(refusedPart).toBeGreaterThan(0);
          expect(refusedRendering).toBeGreaterThan(0);
        });
      });

      it("returns a base-scope rendering a reader elsewhere reads as base", () => {
        // The case the ruling turns on. A rendering that omitted the base
        // suffix would be filled from wherever it was read, so reading one
        // from a `@user` shuttle is what tells "the scope was written and
        // read" apart from "the scope was absent and supplied".

        const place = atPiece();
        expect(place.place.scope).toBe("space");
        const elsewhere = atSpaceRoot();
        elsewhere.cd("@user");
        elsewhere.cd(printedPosition(place));
        expect(elsewhere.place).toEqual(place.place);
      });

      it("returns a container rendering whose refusal names the right fault", () => {
        // A container's rendering starts with the space's `@`, so pasting
        // one back reaches the scope reading. The refusal has to be about
        // what was pasted rather than about a scope word nobody wrote.

        const place = inSlugs();
        const move = atSpaceRoot().cd(printedPosition(place));
        expect(move).toEqual({
          kind: "refused",
          reason: "`@did:key:z6MkConnectedSpace/slugs/` names no scope: a " +
            "scope word holds no `/`. What `pwd` prints for a space root " +
            "or a facet is spelled this way and names no cell — reach one " +
            "by its facet or its piece.",
        });
      });

      it("returns a space root rendering `cd` refuses", () => {
        const place = atSpaceRoot();
        expect(place.cd(printedPosition(place)).kind).toBe("refused");
        expect(place.place).toEqual(placeAtSpaceRoot(SPACE));
      });

      it("returns a facet rendering `cd` refuses", () => {
        const place = inSlugs();
        const facet = place.place;
        expect(place.cd(printedPosition(place)).kind).toBe("refused");
        expect(place.place).toEqual(facet);
      });
    });
  });

  describe("label()", () => {
    // The short form the prompt carries. What every case here turns on is
    // that it says what the place holds and nothing else: the space is left
    // out, and nothing that stays is abbreviated.

    it("returns a space root as the separator alone, and the scope", () => {
      expect(atSpaceRoot().label()).toBe("/ @space");
    });

    it("returns a facet with the separator that says it is one", () => {
      expect(inSlugs().label()).toBe("/slugs/ @space");
    });

    it("returns a piece and its path without the space in front", () => {
      const place = atPiece();
      place.cd("topics/3");
      expect(place.label()).toBe("board/topics/3 @space");
    });

    it("returns the scope the place reads through", () => {
      const place = atPiece();
      place.cd("@session");
      expect(place.label()).toBe("board @session");
    });

    it("returns a piece named as the operand named it, cut down no further", () => {
      // The prompt does no shortening beyond leaving the space out, so a
      // handle prints whole. A prefix of one would print exactly as a whole
      // handle does, and nothing in it would say which it was.

      expect(atReferencedPiece().label()).toBe(`${HANDLE} @space`);
    });

    it("returns a key holding the separator as one segment", () => {
      const place = atPiece();
      place.cd("/board/a~1b");
      expect(place.label()).toBe("board/a~1b @space");
    });
  });

  describe("a part a terminal would act on", () => {
    // The classification the doors turn on, pinned one character at a time.
    // The matrix above sorts a refusal and a round trip into buckets and
    // asserts only that each bucket has something in it, so a character moving
    // between them leaves it green. What says which bucket a character is in
    // is here.

    const ACTED_ON: [string, string][] = [
      ["\u0000", "a null"],
      ["\t", "a tab"],
      ["\u000b", "a vertical tab"],
      ["\f", "a form feed"],
      ["\r", "a carriage return"],
      ["\u001b", "an escape"],
      ["\u007f", "a delete"],
      ["\u009b", "the C1 sequence introducer"],
    ];

    const PRINTED: [string, string][] = [
      ["\u00a0", "a no-break space"],
      ["\u2028", "the line separator"],
      ["\u2029", "the paragraph separator"],
    ];

    it("refuses a segment holding one, whichever door reads it", () => {
      for (const [mark] of ACTED_ON) {
        const walked = atPiece();
        expect(walked.cd(`b${mark}c`)).toEqual({
          kind: "refused",
          reason: `\`b${mark}c\` has a segment holding a control ` +
            "character, so a terminal would act on it rather than print it.",
        });
        const entered = atSpaceRoot();
        const move = entered.enter(
          { space: SPACE, piece: HANDLE, path: [`b${mark}c`] },
          "#x",
        );
        expect(move.kind).toBe("refused");
        expect(entered.place).toEqual(placeAtSpaceRoot(SPACE));
      }
    });

    it("refuses a piece holding one, which the handle rule's length test takes", () => {
      // `isPieceHandle` counts characters rather than reading them, so a
      // handle-shaped piece carries anything past the vocabulary check. The
      // reason is that door's own: no slug holds one and base64url has none.

      for (const [mark] of ACTED_ON) {
        const piece = `of:fid1:aaaaaaaaaa${mark}aaaaaaaaa`;
        expect(atSpaceRoot().cd(`/${piece}`)).toEqual({
          kind: "refused",
          reason: `\`/${piece}\` has a piece holding a control character, ` +
            "so no piece carries that name: a slug is lowercase letters, " +
            "numbers, and single hyphens between words, and a handle is " +
            "`of:fid1:` and unpadded base64url.",
        });
      }
    });

    it("admits a separator a terminal prints rather than acts on", () => {
      // These keep company with the others in habit rather than in any rule:
      // a reader of text breaks a line on them and a terminal does not, and
      // the printer quotes them, being whitespace to the split.

      for (const [mark] of PRINTED) {
        const at = atPiece();
        expect(at.cd(`b${mark}c`).kind).toBe("moved");
        expect(at.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: "board",
          path: [`b${mark}c`],
        });
      }
    });

    it("leaves a line break the reason it already had, which is not this one", () => {
      // A break is acted on by a terminal too, and one door earlier it is
      // refused for the older harm: the rendering would split and a shorter
      // reference would name another cell. What a person is told is the reason
      // that describes what would actually go wrong.

      expect(atPiece().cd("b\nc")).toEqual({
        kind: "refused",
        reason: "`b\nc` has a segment holding a line break, so a rendering " +
          "of the place would name a different cell.",
      });
    });
  });

  describe("CurrentPlace", () => {
    describe("constructor()", () => {
      it("returns an instance standing at the root of the space it was given", () => {
        // The constructor takes a space and not a place, so there is no
        // door here for a position the other four would refuse.

        expect(atSpaceRoot().place).toEqual(placeAtSpaceRoot(SPACE));
      });

      it("returns an instance with no previous place", () => {
        expect(atSpaceRoot().previous).toBeUndefined();
      });
    });

    describe("instance members", () => {
      describe("place", () => {
        it("returns the place a landed move moved to", () => {
          const place = atSpaceRoot();
          place.cd("pieces");
          expect(place.place).toEqual({
            position: { kind: "facet", space: SPACE, facet: "pieces" },
            scope: "space",
          });
        });

        it("returns the place shuttle stood at when a move is refused", () => {
          const place = atSpaceRoot();
          place.cd("board");
          expect(place.place).toEqual(placeAtSpaceRoot(SPACE));
        });

        it("returns the place shuttle stood at for a wish target", () => {
          const place = atSpaceRoot();
          place.cd("#favorites");
          expect(place.place).toEqual(placeAtSpaceRoot(SPACE));
        });

        it("returns the place shuttle stood at for a space named by name", () => {
          const place = atSpaceRoot();
          place.cd(`/@estuary/${HANDLE}`);
          expect(place.place).toEqual(placeAtSpaceRoot(SPACE));
        });
      });

      describe("previous", () => {
        it("returns the place a landed move moved out of", () => {
          const place = atSpaceRoot();
          place.cd("slugs");
          expect(place.previous).toEqual(placeAtSpaceRoot(SPACE));
        });

        it("returns nothing after a refused move", () => {
          const place = atSpaceRoot();
          place.cd("board");
          expect(place.previous).toBeUndefined();
        });
      });

      describe("cd()", () => {
        it("refuses an empty operand", () => {
          expect(atSpaceRoot().cd("  ")).toEqual({
            kind: "refused",
            reason: "`cd` takes a place to move to.",
          });
        });

        describe("the previous place", () => {
          it("returns to the previous place for `-`", () => {
            const place = atPiece();
            place.cd("topics");
            expect(place.cd("-")).toEqual({
              kind: "moved",
              place: {
                position: {
                  kind: "piece",
                  space: SPACE,
                  piece: "board",
                  path: [],
                },
                scope: "space",
              },
            });
          });

          it("swaps the two places, so a second `-` goes back again", () => {
            const place = atPiece();
            place.cd("topics");
            place.cd("-");
            place.cd("-");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: "board",
              path: ["topics"],
            });
          });

          it("restores the route, so `..` backs out the way it came", () => {
            const place = atPiece();
            place.cd("..");
            place.cd("-");
            place.cd("..");
            expect(place.place.position).toEqual({
              kind: "facet",
              space: SPACE,
              facet: "slugs",
            });
          });

          it("refuses `-` while there is no previous place", () => {
            expect(atSpaceRoot().cd("-")).toEqual({
              kind: "refused",
              reason: "There is no previous place to return to.",
            });
          });
        });

        describe("scope", () => {
          it("moves the scope alone for `@session`", () => {
            const place = atPiece();
            expect(place.cd("@session")).toEqual({
              kind: "moved",
              place: {
                position: {
                  kind: "piece",
                  space: SPACE,
                  piece: "board",
                  path: [],
                },
                scope: "session",
              },
            });
          });

          it("moves the scope back to the base for `@space`", () => {
            const place = atSpaceRoot();
            place.cd("@user");
            place.cd("@space");
            expect(place.place.scope).toBe("space");
          });

          it("keeps the route, so `..` still backs out to the facet", () => {
            const place = atPiece();
            place.cd("@session");
            place.cd("..");
            expect(place.place.position).toEqual({
              kind: "facet",
              space: SPACE,
              facet: "slugs",
            });
          });

          it("refuses a suffix naming no scope", () => {
            expect(atSpaceRoot().cd("@overlay")).toEqual({
              kind: "refused",
              reason: "`@overlay` names no scope. The scopes are `@space`, " +
                "`@user`, and `@session`.",
            });
          });

          it("moves position and scope together for `board@session`", () => {
            const place = inSlugs();
            expect(place.cd("board@session")).toEqual({
              kind: "moved",
              place: {
                position: {
                  kind: "piece",
                  space: SPACE,
                  piece: "board",
                  path: [],
                },
                scope: "session",
              },
            });
          });

          it("refuses a piece left ending in whitespace by a scope suffix", () => {
            // `cd board @space` is an ordinary typo. The suffix splits off
            // cleanly and what remains is a piece the rendering would not
            // name back, so the check runs on the piece the split produced
            // rather than on the segment that carried it.

            expect(inSlugs().cd("board @space")).toEqual({
              kind: "refused",
              reason: "`board @space` has a piece ending in whitespace, " +
                "so no piece carries that name: a slug is lowercase " +
                "letters, numbers, and single hyphens between words, and a " +
                "handle is `of:fid1:` and unpadded base64url.",
            });
          });

          it("refuses a piece holding `@`", () => {
            // The split reads the last `@` as a scope, so a piece holding
            // one is read back shortened. No slug or handle carries the
            // character, so nothing nameable is lost.

            expect(inSlugs().cd("board@session@session")).toEqual({
              kind: "refused",
              reason: "`board@session@session` has a piece holding `@`, " +
                "so no piece carries that name: a slug is lowercase " +
                "letters, numbers, and single hyphens between words, and a " +
                "handle is `of:fid1:` and unpadded base64url.",
            });
          });

          it("refuses a segment that is only a scope suffix", () => {
            expect(atSpaceRoot().cd("slugs/@user")).toEqual({
              kind: "refused",
              reason: "`@user` names no piece. A scope suffix rides a piece " +
                "id, and a scope on its own is a whole operand rather than " +
                "a segment.",
            });
          });

          it("refuses a suffix on a piece segment naming no scope", () => {
            // The same refusal a scope-only operand gets, since it is the
            // same fault: shuttle owns the scope words, so the wording is
            // its own rather than the parser's, which speaks of link
            // handles a reader never typed.

            expect(inSlugs().cd("board@overlay")).toEqual({
              kind: "refused",
              reason: "`@overlay` names no scope. The scopes are `@space`, " +
                "`@user`, and `@session`.",
            });
          });
        });

        describe("references", () => {
          it("takes the space from the place for a rooted reference", () => {
            expect(atPiece().cd(`/${HANDLE}/topics/3`)).toEqual({
              kind: "moved",
              place: {
                position: {
                  kind: "piece",
                  space: SPACE,
                  piece: HANDLE,
                  path: ["topics", 3],
                },
                scope: "space",
              },
            });
          });

          it("moves for a complete reference naming the connected space", () => {
            expect(atSpaceRoot().cd(`/@${SPACE}/${HANDLE}`)).toEqual({
              kind: "moved",
              place: {
                position: {
                  kind: "piece",
                  space: SPACE,
                  piece: HANDLE,
                  path: [],
                },
                scope: "space",
              },
            });
          });

          it("keeps the scope the place was reading through", () => {
            // A reference without a suffix says nothing about scope, so the
            // ambient one fills it, the way the place fills the levels the
            // reference omits.

            const place = atSpaceRoot();
            place.cd("@session");
            place.cd(`/${HANDLE}/title`);
            expect(place.place.scope).toBe("session");
          });

          it("names two cells for one suffix-less string read at two scopes", () => {
            // The observable the always-emit ruling rests on, and the one
            // the taxonomy turns on: a complete reference carries its space
            // and not its scope, so the reader supplies the level it does
            // not carry. Nothing else here reads a suffix-less reference —
            // every rendering the property case reads back carries a
            // suffix, because that is what `pwd` writes.

            const reference = `/@${SPACE}/${HANDLE}/title`;
            const reader = (scope: CellScope): CurrentPlace => {
              const place = atSpaceRoot();
              place.cd(`@${scope}`);
              place.cd(reference);
              return place;
            };
            expect(reader("user").place.scope).toBe("user");
            expect(reader("session").place.scope).toBe("session");
            expect(reader("user").place).not.toEqual(reader("session").place);
          });

          it("names one cell for a fully qualified string read at two scopes", () => {
            const reference = `/@${SPACE}/${HANDLE}@user/title`;
            const reader = (scope: CellScope): CurrentPlace => {
              const place = atSpaceRoot();
              place.cd(`@${scope}`);
              place.cd(reference);
              return place;
            };
            expect(reader("space").place).toEqual(reader("session").place);
            expect(reader("space").place.scope).toBe("user");
          });

          it("refuses a complete reference naming another space", () => {
            // Relayed: the canonical layer's sentence, not shuttle's
            // to choose. See the file header.

            expect(atSpaceRoot().cd(`/@${OTHER_SPACE}/${HANDLE}`)).toEqual({
              kind: "refused",
              reason: `Reference names space "${OTHER_SPACE}" but the ` +
                `command targets space "${SPACE}".`,
            });
          });

          it("takes the scope from an `@scope` suffix on the piece", () => {
            expect(atSpaceRoot().cd(`/${HANDLE}@user/title`)).toEqual({
              kind: "moved",
              place: {
                position: {
                  kind: "piece",
                  space: SPACE,
                  piece: HANDLE,
                  path: ["title"],
                },
                scope: "user",
              },
            });
          });

          it("refuses a reference carrying `#argument`", () => {
            expect(atSpaceRoot().cd(`/${HANDLE}#argument`)).toEqual({
              kind: "refused",
              reason:
                "A place is result-rooted, so `cd` takes no `#argument` " +
                "suffix. A place rooted at the arguments cell would leave " +
                "every later relative read ambiguous about which side of " +
                "the piece it addressed. Reach arguments per operand " +
                "instead, as in `get topics/3#argument`.",
            });
          });

          it("refuses a reference carrying any other fragment", () => {
            // Relayed: the canonical layer's sentence, not shuttle's
            // to choose. See the file header.

            const move = atSpaceRoot().cd(`/${HANDLE}#result`);
            expect(move).toEqual({
              kind: "refused",
              reason: 'Unknown suffix "#result". The one supported suffix ' +
                'is "#argument", which selects the piece\'s arguments cell ' +
                'the way "--input" does.',
            });
          });

          it("refuses a reference holding an empty segment", () => {
            // A rendering has to name the position it was printed for. The
            // reference grammar drops a trailing empty segment, so a path
            // ending in one would print as a reference to the piece above
            // it — a different cell, with nothing said. The walk already
            // refuses the spelling; this is the same refusal at the other
            // door, and it costs the empty key its only spelling.

            expect(atSpaceRoot().cd(`/${HANDLE}//`)).toEqual({
              kind: "refused",
              reason: `\`/${HANDLE}//\` has an empty segment, ` +
                `so a rendering of the place would name a different cell.`,
            });
          });

          it("refuses a reference holding an empty segment mid-path", () => {
            expect(atSpaceRoot().cd(`/${HANDLE}/a//b`)).toEqual({
              kind: "refused",
              reason: `\`/${HANDLE}/a//b\` has an empty segment, ` +
                `so a rendering of the place would name a different cell.`,
            });
          });

          it("reads a trailing slash as the piece itself", () => {
            const place = atSpaceRoot();
            place.cd(`/${HANDLE}/`);
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: [],
            });
          });

          it("refuses a reference whose piece holds a line break", () => {
            // A handle is held to its length rather than its alphabet, so a
            // reference can carry a piece the rendering would not name back
            // even after the canonical parse has accepted it.

            expect(atSpaceRoot().cd("/of:fid1:abc\ndefghijklmnop")).toEqual({
              kind: "refused",
              reason: "`/of:fid1:abc\ndefghijklmnop` has a piece holding a " +
                "line break, so a rendering of the place would name a " +
                "different cell.",
            });
          });

          it("refuses a reference holding a segment that ends in whitespace", () => {
            expect(atSpaceRoot().cd(`/${HANDLE}/a /b`)).toEqual({
              kind: "refused",
              reason: `\`/${HANDLE}/a /b\` has a segment ending in ` +
                `whitespace, so a rendering of the place would name a different cell.`,
            });
          });

          it("moves for a reference holding a segment that starts with one", () => {
            // The parse trims the whole string, which no leading character
            // of a segment sits at the end of, so leading whitespace
            // survives the round trip and is admitted.

            const place = atSpaceRoot();
            place.cd(`/${HANDLE}/ a/b`);
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: [" a", "b"],
            });
          });

          it("refuses a rooted string that names no piece", () => {
            // Relayed: the canonical layer's sentence, not shuttle's
            // to choose. See the file header.

            expect(atSpaceRoot().cd("//")).toEqual({
              kind: "refused",
              reason:
                'Target must include a piece handle, e.g. "/of:fid1:abc123/path".',
            });
          });

          it("hands back a reference naming its space by name", () => {
            // The arm carries no space. Whether the name denotes the
            // connected one is what is not yet known, so there is nothing
            // for a space field to hold that would not be a guess.

            expect(atSpaceRoot().cd(`/@estuary/${HANDLE}/title`)).toEqual({
              kind: "space-by-name",
              name: "estuary",
              piece: HANDLE,
              path: ["title"],
              scope: "space",
            });
          });
        });

        describe("the space root", () => {
          it("moves to the space root for `/` from a piece", () => {
            expect(atPiece().cd("/")).toEqual({
              kind: "moved",
              place: {
                position: { kind: "root", space: SPACE },
                scope: "space",
              },
            });
          });

          it("moves to the space root for `/` from a path in a piece", () => {
            const place = atPiece();
            place.cd("topics/3");
            place.cd("/");
            expect(place.place.position).toEqual({
              kind: "root",
              space: SPACE,
            });
          });

          it("moves to the space root for `/` from a facet", () => {
            const place = inSlugs();
            place.cd("/");
            expect(place.place.position).toEqual({
              kind: "root",
              space: SPACE,
            });
          });

          it("leaves the scope alone for `/`", () => {
            const place = atPiece();
            place.cd("@session");
            place.cd("/");
            expect(place.place.scope).toBe("session");
          });
        });

        describe("wish targets", () => {
          it("hands back a `#name` target for the connection to resolve", () => {
            expect(atSpaceRoot().cd("#favorites")).toEqual({
              kind: "wish",
              target: "#favorites",
            });
          });

          it("hands back `#argument` as a target rather than refusing it", () => {
            // The wish reading is decided on the whole operand, so it does
            // not ask which word follows the `#`. `#argument` earns the
            // result-rooted refusal as a *suffix* on a reference; standing
            // alone it is a target name like any other, and the connection
            // is what discovers there is none. The case below drives the
            // same point through a spelling a reference refuses outright.

            expect(atSpaceRoot().cd("#argument")).toEqual({
              kind: "wish",
              target: "#argument",
            });
          });

          it("hands back a target holding a second `#`", () => {
            expect(atSpaceRoot().cd("#a#b")).toEqual({
              kind: "wish",
              target: "#a#b",
            });
          });
        });

        describe("relative segments", () => {
          it("moves into a facet named at the space root", () => {
            expect(atSpaceRoot().cd("slugs")).toEqual({
              kind: "moved",
              place: {
                position: { kind: "facet", space: SPACE, facet: "slugs" },
                scope: "space",
              },
            });
          });

          it("refuses a segment at the space root naming no facet", () => {
            expect(atSpaceRoot().cd("board")).toEqual({
              kind: "refused",
              reason: "A space root lists facets, and `board` names none. " +
                "The facets are `slugs/` and `pieces/`.",
            });
          });

          it("moves to a piece named inside a facet", () => {
            expect(inSlugs().cd("board")).toEqual({
              kind: "moved",
              place: {
                position: {
                  kind: "piece",
                  space: SPACE,
                  piece: "board",
                  path: [],
                },
                scope: "space",
              },
            });
          });

          it("refuses a piece segment that is in neither vocabulary", () => {
            // Relayed: `validatePieceSegment`'s own sentence, which the walk
            // calls rather than copies.

            expect(inSlugs().cd("Board")).toEqual({
              kind: "refused",
              reason: '"Board" is not a slug: a slug is lowercase letters, ' +
                "numbers, and single hyphens between words.",
            });
          });

          it("gives a piece segment the reason a reference's gets", () => {
            // Which is the whole of the ruling: a piece is held to the two
            // vocabularies whichever door reached it, so a name a listing
            // cannot print as an operand is one no door takes.

            expect(inSlugs().cd("Board")).toEqual(atSpaceRoot().cd("/Board"));
          });

          it("reads a canonical index inside a piece as a number", () => {
            const place = atPiece();
            place.cd("topics/3");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: "board",
              path: ["topics", 3],
            });
          });

          it("refuses `#argument` in a segment naming a piece for the same reason as a reference", () => {
            // A place is result-rooted however the suffix was written, so
            // the two spellings are pinned equal rather than each pinning
            // its own text. That is what keeps a remedy naming the
            // reference form — which `cd` refuses in turn — out of this
            // one.

            expect(inSlugs().cd("board#argument")).toEqual(
              atSpaceRoot().cd(`/${HANDLE}#argument`),
            );
          });

          it("refuses any other fragment for carrying no suffix at all", () => {
            expect(inSlugs().cd("board#result")).toEqual({
              kind: "refused",
              reason: 'Unknown suffix "#result". The one supported suffix ' +
                'is "#argument", which selects the piece\'s arguments cell ' +
                'the way "--input" does.',
            });
          });

          it("gives a bare fragment the wording a reference's gets", () => {
            // The two are copies: shuttle authors this one so the surfaces
            // read as one, and the canonical layer authors the other. Only
            // pinning them equal makes a reword that moves one and not the
            // other fail here rather than diverge quietly.

            expect(inSlugs().cd("board#result")).toEqual(
              atSpaceRoot().cd(`/${HANDLE}#result`),
            );
          });

          it("names the whole fragment, not the part before a second `#`", () => {
            expect(inSlugs().cd("board#argument#x")).toEqual({
              kind: "refused",
              reason: 'Unknown suffix "#argument#x". The one supported ' +
                'suffix is "#argument", which selects the piece\'s ' +
                'arguments cell the way "--input" does.',
            });
          });

          it("refuses a facet segment carrying a fragment for naming no facet", () => {
            expect(atSpaceRoot().cd("slugs#argument")).toEqual({
              kind: "refused",
              reason: "A space root lists facets, and `slugs#argument` " +
                "names none. The facets are `slugs/` and `pieces/`.",
            });
          });

          it("reads `#` inside a piece as part of a data key", () => {
            const place = atPiece();
            place.cd("topics#argument");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: "board",
              path: ["topics#argument"],
            });
          });

          it("reads `@` inside a segment as part of a data key", () => {
            const place = atPiece();
            place.cd("mail@example");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: "board",
              path: ["mail@example"],
            });
          });

          it("refuses a leading `@` inside a piece, reading it as a scope word", () => {
            expect(atPiece().cd("@foo")).toEqual({
              kind: "refused",
              reason: "`@foo` names no scope. The scopes are `@space`, " +
                "`@user`, and `@session`.",
            });
          });

          it("trims the outer edges of an operand before splitting it", () => {
            // A reference keeps what the walk drops here, and the walk is
            // the only door that drops it — so a key named `" a"` is
            // reachable by reference and not by walking to it. Landing on
            // the trimmed key rather than refusing is what makes this
            // worth pinning: nothing says the edge was lost.

            const place = atReferencedPiece();
            place.cd(" a ");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: ["a"],
            });
          });

          it("reads `~1` in a segment as two characters of a data key", () => {
            // A relative operand is not a reference, so the reference
            // grammar's `~1` escaping does not reach it: `~1` is literal
            // here where a reference reads it as a literal `/` inside the
            // key. The case below is the consequence — a key holding a `/`
            // has no relative spelling, the walk splitting on the separator
            // it holds — and both are pinned so that teaching the walk to
            // unescape reds a case rather than arriving unremarked. Such a
            // key is named by a reference instead, which unescapes `~1`, and
            // that is the spelling `operandForChild` offers for it.

            const place = atReferencedPiece();
            place.cd("a~1b");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: ["a~1b"],
            });
          });

          it("splits at every `/`, giving two keys rather than one holding it", () => {
            const place = atReferencedPiece();
            place.cd("a/b");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: ["a", "b"],
            });
          });

          describe("reserved readings", () => {
            // Each of these drives its character at the head of a later
            // segment, where the head-of-operand cases drive it first.
            // That position is what tells a reading decided on the whole
            // operand from one decided segment by segment, so these pin
            // which kind each reading is rather than several instances of
            // one kind.

            it("reads `-` as a data key in a later segment", () => {
              const place = atReferencedPiece();
              place.cd("a/-");
              expect(place.place.position).toEqual({
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: ["a", "-"],
              });
            });

            it("reads `@foo` as a data key in a later segment", () => {
              const place = atReferencedPiece();
              place.cd("a/@foo");
              expect(place.place.position).toEqual({
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: ["a", "@foo"],
              });
            });

            it("reads `#b` as a data key in a later segment", () => {
              const place = atReferencedPiece();
              place.cd("a/#b");
              expect(place.place.position).toEqual({
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: ["a", "#b"],
              });
            });

            it("reads `-` as a data key in the first segment", () => {
              // `-` is matched against the whole operand exactly, where `@`
              // and a leading `#` are matched against its head. So a key
              // named `-` is spellable first and those two are not.

              const place = atReferencedPiece();
              place.cd("-/b");
              expect(place.place.position).toEqual({
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: ["-", "b"],
              });
            });

            it("reads `..` as a data key through a reference", () => {
              // `..` is read segment by segment by the walk and by nothing
              // else, so the reference door carries one as data. That is
              // the only spelling a key named `..` has.

              const place = atSpaceRoot();
              place.cd(`/${HANDLE}/..`);
              expect(place.place.position).toEqual({
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: [".."],
              });
            });

            it("reads `..` as a level to leave in a later segment", () => {
              const place = atReferencedPiece();
              place.cd("a/..");
              expect(place.place.position).toEqual({
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: [],
              });
            });
          });

          it("walks every level of a multi-segment operand", () => {
            const place = atSpaceRoot();
            place.cd("slugs/board/topics/3");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: "board",
              path: ["topics", 3],
            });
          });

          it("ignores a trailing slash", () => {
            const place = atSpaceRoot();
            place.cd("slugs/");
            expect(place.place.position).toEqual({
              kind: "facet",
              space: SPACE,
              facet: "slugs",
            });
          });

          it("refuses an operand with a segment ending in whitespace", () => {
            // The operand is trimmed before it is split, so only a segment
            // with something after it can carry trailing whitespace this
            // far.

            expect(atReferencedPiece().cd("a /b")).toEqual({
              kind: "refused",
              reason: "`a /b` has a segment ending in whitespace, so a " +
                "rendering of the place would name a different cell.",
            });
          });

          it("gives a piece-name segment the piece's reason, not a segment's", () => {
            // The same flaw in the same operand shape, one segment along
            // from `a /b` above, which gets the segment reason. A piece
            // ending in whitespace does not name another cell — the scope
            // suffix stands between it and the trim — so it must not be
            // told that it does.

            expect(inSlugs().cd("board /x")).toEqual({
              kind: "refused",
              reason: "`board /x` has a piece ending in whitespace, so no " +
                "piece carries that name: a slug is lowercase letters, " +
                "numbers, and single hyphens between words, and a handle " +
                "is `of:fid1:` and unpadded base64url.",
            });
          });

          it("refuses an operand whose empty part would name a piece", () => {
            // The empty part sits where a piece name goes, so it is held to
            // the piece rule and told the piece's reason. A segment is
            // faulted by what it is about to become, not by its position.

            expect(atSpaceRoot().cd("slugs//board")).toEqual({
              kind: "refused",
              reason: "`slugs//board` has an empty piece, so no piece " +
                "carries that name: a slug is lowercase letters, numbers, " +
                "and single hyphens between words, and a handle is " +
                "`of:fid1:` and unpadded base64url.",
            });
          });
        });

        describe("`..`", () => {
          it("stays at the space root", () => {
            const place = atSpaceRoot();
            expect(place.cd("..")).toEqual({
              kind: "moved",
              place: placeAtSpaceRoot(SPACE),
            });
          });

          it("walks out one level per `..`", () => {
            const place = atPiece();
            place.cd("..");
            place.cd("..");
            expect(place.place.position).toEqual({
              kind: "root",
              space: SPACE,
            });
          });

          it("keeps the scope backing out of a piece a reference named", () => {
            const place = atSpaceRoot();
            place.cd(`/${HANDLE}@user`);
            place.cd("..");
            expect(place.place.scope).toBe("user");
          });

          it("moves from a facet to the space root", () => {
            const place = inSlugs();
            place.cd("..");
            expect(place.place.position).toEqual({
              kind: "root",
              space: SPACE,
            });
          });

          it("drops the last path segment inside a piece", () => {
            const place = atPiece();
            place.cd("topics/3");
            place.cd("..");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: "board",
              path: ["topics"],
            });
          });

          it("moves from a piece back out to the facet it came through", () => {
            const place = atPiece();
            place.cd("..");
            expect(place.place.position).toEqual({
              kind: "facet",
              space: SPACE,
              facet: "slugs",
            });
          });

          it("drops a path segment inside a piece a reference named", () => {
            const place = atSpaceRoot();
            place.cd(`/${HANDLE}/topics/3`);
            place.cd("..");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: ["topics"],
            });
          });

          it("moves from a piece a reference named to the space root", () => {
            const place = atSpaceRoot();
            place.cd(`/${HANDLE}`);
            place.cd("..");
            expect(place.place.position).toEqual({
              kind: "root",
              space: SPACE,
            });
          });

          it("keeps the scope while the position moves", () => {
            const place = atPiece();
            place.cd("@session");
            place.cd("..");
            expect(place.place.scope).toBe("session");
          });
        });
      });

      describe("aim()", () => {
        // The read door. It differs from `cd()` in two ways and this block is
        // both of them: nothing moves, and a trailing `#argument` is read
        // rather than refused. Everything else is `cd()`'s reading, so what is
        // asked here is only that the operand arrives at it — the readings
        // themselves are `cd()`'s block above.

        /** Helper for the cases below, which is where `operand` points. */
        function pointsAt(place: CurrentPlace, operand: string): Move {
          return place.aim(operand).move;
        }

        it("returns where a relative operand points", () => {
          expect(pointsAt(atPiece(), "topics/3")).toEqual({
            kind: "moved",
            place: {
              position: {
                kind: "piece",
                space: SPACE,
                piece: "board",
                path: ["topics", 3],
              },
              scope: "space",
            },
          });
        });

        it("leaves shuttle where it stood", () => {
          const place = atPiece();
          const before = place.place;
          place.aim("topics/3");
          expect(place.place).toBe(before);
        });

        it("returns no selection of the arguments cell for an operand carrying no suffix", () => {
          expect(atPiece().aim("topics").input).toBe(false);
        });

        it("returns the arguments cell selected for an operand ending in `#argument`", () => {
          expect(atPiece().aim("topics#argument").input).toBe(true);
        });

        it("returns the position the operand names with the suffix off it", () => {
          expect(atPiece().aim("topics/3#argument").move).toEqual(
            pointsAt(atPiece(), "topics/3"),
          );
        });

        it("reads the suffix off a bare piece designation, which `cd` refuses", () => {
          // The asymmetry the door exists for, on the one spelling where the
          // two doors visibly disagree: `cd` turns the suffix down because a
          // place is result-rooted, and a read is not standing anywhere.
          const place = inSlugs();
          expect(place.aim("board#argument")).toEqual({
            input: true,
            move: pointsAt(inSlugs(), "board"),
          });
          expect(inSlugs().cd("board#argument").kind).toBe("refused");
        });

        it("reads the suffix off a rooted reference", () => {
          expect(atSpaceRoot().aim(`/${HANDLE}/title#argument`)).toEqual({
            input: true,
            move: pointsAt(atSpaceRoot(), `/${HANDLE}/title`),
          });
        });

        it("refuses the suffix written with nothing in front of it", () => {
          expect(atPiece().aim("#argument")).toEqual({
            input: false,
            move: {
              kind: "refused",
              reason: "`#argument` selects a piece's arguments cell, so it " +
                "follows the target it selects, as in `get topics#argument`.",
            },
          });
        });

        it("hands a `#name` target on whole, the head reading being another one", () => {
          expect(atPiece().aim("#favorites")).toEqual({
            input: false,
            move: { kind: "wish", target: "#favorites" },
          });
        });

        it("takes a `#` inside a piece as a character of a key", () => {
          // The suffix reading is the one spelling it accepts and nothing
          // wider, so every other `#` reaches the door that decides it — here
          // the walk, where `#` is data.
          expect(atPiece().aim("a#b")).toEqual({
            input: false,
            move: pointsAt(atPiece(), "a#b"),
          });
          expect(pointsAt(atPiece(), "a#b").kind).toBe("moved");
        });

        it("carries the reason a reference gave a fragment that is no suffix", () => {
          expect(atSpaceRoot().aim(`/${HANDLE}/a#b`)).toEqual({
            input: false,
            move: {
              kind: "refused",
              reason: 'Unknown suffix "#b". The one supported suffix is ' +
                '"#argument", which selects the piece\'s arguments cell the ' +
                'way "--input" does.',
            },
          });
        });
      });

      describe("enter()", () => {
        it("moves to a target that resolved in the connected space", () => {
          const place = atSpaceRoot();
          expect(
            place.enter(
              { space: SPACE, piece: HANDLE, path: ["title"] },
              "#favorites",
            ),
          ).toEqual({
            kind: "moved",
            place: {
              position: {
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: ["title"],
              },
              scope: "space",
            },
          });
        });

        it("stands at the piece itself for a target carrying no path", () => {
          const place = atSpaceRoot();
          place.enter({ space: SPACE, piece: HANDLE }, "#favorites");
          expect(place.place.position).toEqual({
            kind: "piece",
            space: SPACE,
            piece: HANDLE,
            path: [],
          });
        });

        it("normalizes the path the way a reference's is normalized", () => {
          // A position names its cell and nothing about how it was reached,
          // so every door has to agree on what a segment means. A canonical
          // index is where they would part: a door that skips the conversion
          // lands a string where the others land a number.

          const entered = atSpaceRoot();
          entered.enter({ space: SPACE, piece: HANDLE, path: ["3"] }, "#x");
          const referenced = atSpaceRoot();
          referenced.cd(`/${HANDLE}/3`);
          expect(entered.place).toEqual(referenced.place);
          expect(entered.place.position).toEqual({
            kind: "piece",
            space: SPACE,
            piece: HANDLE,
            path: [3],
          });
        });

        it("carries no route, so `..` lands on the piece it entered", () => {
          const entered = atSpaceRoot();
          entered.enter({ space: SPACE, piece: HANDLE, path: ["3"] }, "#x");
          entered.cd("..");
          expect(entered.place.position).toEqual({
            kind: "piece",
            space: SPACE,
            piece: HANDLE,
            path: [],
          });
        });

        it("refuses a target whose path holds an empty segment", () => {
          expect(
            atSpaceRoot().enter(
              { space: SPACE, piece: HANDLE, path: ["a", ""] },
              "#favorites",
            ),
          ).toEqual({
            kind: "refused",
            reason: "`#favorites` resolves to a path with an empty " +
              "segment, so a rendering of the place would name a different cell.",
          });
        });

        it("refuses a target whose piece is empty", () => {
          expect(
            atSpaceRoot().enter(
              { space: SPACE, piece: "", path: [] },
              "#favorites",
            ),
          ).toEqual({
            kind: "refused",
            reason: "`#favorites` resolves to an empty piece, so no piece " +
              "carries that name: a slug is lowercase letters, numbers, and " +
              "single hyphens between words, and a handle is `of:fid1:` and " +
              "unpadded base64url.",
          });
        });

        it("refuses a target whose piece holds `#` though its length passes for a handle", () => {
          // `isPieceHandle` is a length rule, so a piece long enough to
          // pass for a handle carries either character of
          // `READ_INSIDE_AN_ID` past the vocabulary check — and a `#` then
          // costs the place its own rendering, which `cd` refuses as an
          // argument suffix.
          //
          // One case per character, not one per character per door. The rule
          // is a single loop inside `unnameablePiece` that every door calls,
          // and each character is driven at a door with no earlier check of
          // its own — `#` here, `@` through a walk — so dropping either from
          // the loop reds its case. `#` is driven at this door rather than
          // at a walk because a walk refuses a `#` before the rule runs,
          // naming the suffix; dropping `#` from the loop therefore leaves
          // that door refusing it still, which is why the case for it is
          // here. That each door calls the rule at all is a separate axis
          // with cases of its own, and each frames the one `Fault` it gets
          // back in its own sentence.

          expect(
            atSpaceRoot().enter(
              { space: SPACE, piece: "of:fid1:abcdefghij#k", path: [] },
              "#favorites",
            ),
          ).toEqual({
            kind: "refused",
            reason: "`#favorites` resolves to a piece holding `#`, so no " +
              "piece carries that name: a slug is lowercase letters, " +
              "numbers, and single hyphens between words, and a handle is " +
              "`of:fid1:` and unpadded base64url.",
          });
        });

        it("refuses a target whose piece is in neither vocabulary", () => {
          // Relayed: `validatePieceSegment`'s own sentence.

          expect(
            atSpaceRoot().enter(
              { space: SPACE, piece: "Board", path: [] },
              "#favorites",
            ),
          ).toEqual({
            kind: "refused",
            reason: '"Board" is not a slug: a slug is lowercase letters, ' +
              "numbers, and single hyphens between words.",
          });
        });

        it("refuses a target whose piece holds a line break", () => {
          expect(
            atSpaceRoot().enter(
              { space: SPACE, piece: "a\nb", path: [] },
              "#favorites",
            ),
          ).toEqual({
            kind: "refused",
            reason: "`#favorites` resolves to a piece holding a line break, " +
              "so a rendering of the place would name a different cell.",
          });
        });

        it("refuses a target whose path holds a line break", () => {
          // A rendering separates its two lines with a newline, so a
          // segment holding one splits the position line and leaves a
          // shorter reference — one that names another cell rather than
          // failing to parse. A resolver reading JSON keys is the door
          // such a segment arrives through.

          expect(
            atSpaceRoot().enter(
              { space: SPACE, piece: HANDLE, path: ["a\nb"] },
              "#favorites",
            ),
          ).toEqual({
            kind: "refused",
            reason: "`#favorites` resolves to a path with a segment holding " +
              "a line break, so a rendering of the place would name a " +
              "different cell.",
          });
        });

        it("refuses a target whose path holds a segment ending in whitespace", () => {
          expect(
            atSpaceRoot().enter(
              { space: SPACE, piece: HANDLE, path: ["a "] },
              "#favorites",
            ),
          ).toEqual({
            kind: "refused",
            reason: "`#favorites` resolves to a path with a segment ending " +
              "in whitespace, so a rendering of the place would name a different cell.",
          });
        });

        it("keeps the scope the place was reading through", () => {
          // A resolved target names a cell and carries no scope of its own,
          // so the scope the place already holds is what it is read
          // through.

          const place = atSpaceRoot();
          place.cd("@session");
          place.enter({ space: SPACE, piece: HANDLE }, "#favorites");
          expect(place.place.scope).toBe("session");
        });

        it("refuses a target that resolved in another space", () => {
          const place = atSpaceRoot();
          expect(
            place.enter({ space: OTHER_SPACE, piece: HANDLE }, "#profile"),
          ).toEqual({
            kind: "refused",
            reason:
              "`#profile` resolves in space `did:key:z6MkOtherSpace`, and " +
              "this shuttle is connected to `did:key:z6MkConnectedSpace`. " +
              "One connection serves one space, so reaching that cell means " +
              "a shuttle started against that space.",
          });
        });

        it("leaves shuttle where it stood when the target is refused", () => {
          const place = atSpaceRoot();
          place.enter({ space: OTHER_SPACE, piece: HANDLE }, "#profile");
          expect(place.place).toEqual(placeAtSpaceRoot(SPACE));
        });
      });

      describe("settle()", () => {
        it("builds the place from the connected space", () => {
          const place = atSpaceRoot();
          const move = place.cd(`/@estuary/${HANDLE}/title`);
          if (move.kind !== "space-by-name") throw new Error("not handed on");
          expect(place.settle(move, SPACE)).toEqual({
            kind: "moved",
            place: {
              position: {
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: ["title"],
              },
              scope: "space",
            },
          });
        });

        it("keeps the scope a space-named reference asked for", () => {
          const place = atSpaceRoot();
          const move = place.cd(`/@estuary/${HANDLE}@user`);
          if (move.kind !== "space-by-name") throw new Error("not handed on");
          place.settle(move, SPACE);
          expect(place.place.scope).toBe("user");
        });

        it("refuses a name that resolved to another space", () => {
          // The place is built from the connected space, so settling a name
          // that resolved elsewhere would land on the same piece id in the
          // wrong space and say nothing. The space the name resolved to is
          // the caller's to supply and this module's to check.

          const place = atSpaceRoot();
          const move = place.cd(`/@estuary/${HANDLE}`);
          if (move.kind !== "space-by-name") throw new Error("not handed on");
          expect(place.settle(move, OTHER_SPACE)).toEqual({
            kind: "refused",
            reason: "`estuary` resolves to space `did:key:z6MkOtherSpace`, " +
              "and this shuttle is connected to " +
              "`did:key:z6MkConnectedSpace`. One connection serves one " +
              "space, so reaching that cell means a shuttle started against " +
              "that space.",
          });
          expect(place.place).toEqual(placeAtSpaceRoot(SPACE));
        });

        it("carries a number a move already converted through unchanged", () => {
          // A move `cd` minted holds a path the reference grammar already
          // converted, so the number arm of that conversion is the one such
          // a move arrives on.

          const place = atSpaceRoot();
          place.settle({
            kind: "space-by-name",
            name: "estuary",
            piece: HANDLE,
            path: [3],
            scope: "space",
          }, SPACE);
          expect(place.place.position).toEqual({
            kind: "piece",
            space: SPACE,
            piece: HANDLE,
            path: [3],
          });
        });

        it("refuses a move whose path holds a number no digits name back", () => {
          // A number renders as its digits, and only a canonical array
          // index reads back as the number it was. This door is the one
          // documented as taking a caller's own move, so it is where such
          // a path arrives.

          const place = atSpaceRoot();
          expect(place.settle({
            kind: "space-by-name",
            name: "estuary",
            piece: HANDLE,
            path: [1.5],
            scope: "space",
          }, SPACE)).toEqual({
            kind: "refused",
            reason: "The reference naming space `estuary` has a segment " +
              "that is no canonical index, so a rendering of the place " +
              "would name a different cell.",
          });
        });

        it("refuses a move whose path holds a segment no rendering names", () => {
          // The arm is exported, so a caller can build one. `cd` cannot
          // mint a bad path any more, which leaves a hand-built move as the
          // way in — and this door builds a position from it exactly as
          // `enter` builds one from a resolved target.

          const place = atSpaceRoot();
          expect(place.settle({
            kind: "space-by-name",
            name: "estuary",
            piece: HANDLE,
            path: ["a "],
            scope: "space",
          }, SPACE)).toEqual({
            kind: "refused",
            reason: `The reference naming space \`estuary\` has a segment ` +
              `ending in whitespace, so a rendering of the place would name a different cell.`,
          });
          expect(place.place).toEqual(placeAtSpaceRoot(SPACE));
        });

        it("refuses a move whose piece is in neither vocabulary", () => {
          // Relayed: `validatePieceSegment`'s own sentence. A move `cd` minted
          // carries a piece the reference grammar already held to the two
          // vocabularies; one a caller assembled carries whatever it was
          // given, and this door holds that to them too.

          const place = atSpaceRoot();
          expect(place.settle({
            kind: "space-by-name",
            name: "estuary",
            piece: "Board",
            path: [],
            scope: "space",
          }, SPACE)).toEqual({
            kind: "refused",
            reason: '"Board" is not a slug: a slug is lowercase letters, ' +
              "numbers, and single hyphens between words.",
          });
          expect(place.place).toEqual(placeAtSpaceRoot(SPACE));
        });

        it("carries no route, so `..` leaves the piece for the root", () => {
          const place = inSlugs();
          const move = place.cd(`/@estuary/${HANDLE}`);
          if (move.kind !== "space-by-name") throw new Error("not handed on");
          place.settle(move, SPACE);
          place.cd("..");
          expect(place.place.position).toEqual({
            kind: "root",
            space: SPACE,
          });
        });
      });

      describe("render()", () => {
        it("returns both halves of the place it stands at", () => {
          const place = atPiece();
          place.cd("topics/3");
          expect(place.render()).toBe(
            "position  /@did:key:z6MkConnectedSpace/board@space/topics/3\n" +
              "scope     @space",
          );
        });
      });
    });
  });
});
