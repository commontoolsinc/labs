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
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { MemorySpace } from "@commonfabric/memory/interface";

import {
  CurrentPlace,
  FACETS,
  placeAtSpaceRoot,
  renderPlace,
} from "../src/place.ts";

const SPACE = "did:key:z6MkConnectedSpace" as MemorySpace;
const OTHER_SPACE = "did:key:z6MkOtherSpace" as MemorySpace;
const HANDLE = "of:fid1:abcdefghijklmnop";

/** Helper for the cases below, which stands an instance at the space root. */
function atSpaceRoot(): CurrentPlace {
  return new CurrentPlace(placeAtSpaceRoot(SPACE));
}

/** Helper for the cases below, which stands an instance inside `slugs/`. */
function inSlugs(): CurrentPlace {
  const place = atSpaceRoot();
  place.cd("slugs");
  return place;
}

/** Helper for the cases below, which reads the position `pwd` printed. */
function printedPosition(place: CurrentPlace): string {
  const [position] = place.render().split("\n");
  return position.slice("position  ".length);
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

  describe("renderPlace()", () => {
    it("returns a space root with no leading slash, and the scope", () => {
      expect(renderPlace(placeAtSpaceRoot(SPACE))).toBe(
        "position  @did:key:z6MkConnectedSpace/\nscope     @space",
      );
    });

    it("returns a facet with no leading slash", () => {
      expect(renderPlace(inSlugs().place)).toBe(
        "position  @did:key:z6MkConnectedSpace/slugs/\nscope     @space",
      );
    });

    it("returns a piece and its path as a complete reference", () => {
      const place = atPiece();
      place.cd("topics/3");
      place.cd("@session");
      expect(renderPlace(place.place)).toBe(
        "position  /@did:key:z6MkConnectedSpace/board/topics/3\n" +
          "scope     @session",
      );
    });

    describe("round-tripping", () => {
      // What a reader copies whole has to name the place it was printed
      // for, or name nothing. A piece is a cell, so its rendering is a
      // reference and `cd` takes it back; a container is not a cell, so its
      // rendering is not a reference and `cd` refuses it rather than
      // resolving it to a piece whose slug happens to match the container's
      // name. A segment lifted out of a rendering is outside that: the
      // rendering escapes a `/` in a key and a relative operand reads no
      // escape, which the walk's own cases pin.

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
          "/@did:key:z6MkConnectedSpace/of:fid1:abcdefghijklmnop/a~1b",
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

  describe("CurrentPlace", () => {
    describe("constructor()", () => {
      it("returns an instance standing at the place it was given", () => {
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

          it("refuses a suffix on a piece segment naming no scope", () => {
            expect(inSlugs().cd("board@overlay")).toEqual({
              kind: "refused",
              reason: 'Invalid scope suffix "@overlay" in link handle. ' +
                "Expected @space, @user, or @session.",
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

          it("refuses a complete reference naming another space", () => {
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
            const move = atSpaceRoot().cd(`/${HANDLE}#result`);
            expect(move).toEqual({
              kind: "refused",
              reason: 'Unknown reference suffix "#result". The one supported ' +
                'suffix is "#argument", which selects the piece\'s arguments ' +
                'cell the way "--input" does.',
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
              reason: `\`/${HANDLE}//\` has an empty segment.`,
            });
          });

          it("refuses a reference holding an empty segment mid-path", () => {
            expect(atSpaceRoot().cd(`/${HANDLE}/a//b`)).toEqual({
              kind: "refused",
              reason: `\`/${HANDLE}/a//b\` has an empty segment.`,
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

          it("refuses a rooted string that names no piece", () => {
            expect(atSpaceRoot().cd("//")).toEqual({
              kind: "refused",
              reason:
                'Target must include a piece handle, e.g. "/of:fid1:abc123/path".',
            });
          });

          it("hands back a reference naming its space by name", () => {
            expect(atSpaceRoot().cd(`/@estuary/${HANDLE}/title`)).toEqual({
              kind: "space-by-name",
              name: "estuary",
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
              reason: 'Unknown reference suffix "#result". The one ' +
                'supported suffix is "#argument", which the reference form ' +
                "carries and a bare piece id does not.",
            });
          });

          it("names the whole fragment, not the part before a second `#`", () => {
            expect(inSlugs().cd("board#argument#x")).toEqual({
              kind: "refused",
              reason: 'Unknown reference suffix "#argument#x". The one ' +
                'supported suffix is "#argument", which the reference form ' +
                "carries and a bare piece id does not.",
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

          it("reads `~1` in a segment as two characters of a data key", () => {
            // A relative operand is not a reference, so the reference
            // grammar's `~1` escaping does not reach it: `~1` is literal
            // here where a reference reads it as a literal `/` inside the
            // key. The case
            // below is the consequence — a key holding a `/` has no
            // relative spelling at all, since neither candidate reaches it
            // — and both are pinned so that teaching the walk to unescape
            // reds a case rather than arriving unremarked. Which vocabulary
            // a relative segment speaks is settled where `ls` decides how
            // such a key prints, the render and the read wanting to be
            // decided together.

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
            // Where a reading is decided says where it holds. `-`,
            // `@scope`, `/` and a lone leading `#` are read on the whole
            // operand before it is split, so each governs the head alone
            // and is data everywhere after it; `..` is read segment by
            // segment, so it is reserved wherever it appears. These four
            // pin that rule rather than four instances of it, which is why
            // each drives its character at the head of a later segment
            // where the head-of-operand cases drive it first.

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

          it("refuses an operand with an empty segment", () => {
            expect(atSpaceRoot().cd("slugs//board")).toEqual({
              kind: "refused",
              reason: "`slugs//board` has an empty segment.",
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
          // so the three doors have to agree on what a segment means. A
          // canonical index is where they would part: the two `cd` branches
          // convert one to a number and a resolution hands over what it
          // read.

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
            reason: "`#favorites` resolves to a path with an empty segment.",
          });
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
              "One connection serves one space.",
          });
        });

        it("leaves shuttle where it stood when the target is refused", () => {
          const place = atSpaceRoot();
          place.enter({ space: OTHER_SPACE, piece: HANDLE }, "#profile");
          expect(place.place).toEqual(placeAtSpaceRoot(SPACE));
        });
      });

      describe("settle()", () => {
        it("lands the place the move worked out", () => {
          const place = atSpaceRoot();
          const move = place.cd(`/@estuary/${HANDLE}/title`);
          if (move.kind !== "space-by-name") throw new Error("not handed on");
          expect(place.settle(move)).toEqual({
            kind: "moved",
            place: move.place,
          });
        });

        it("keeps the scope a space-named reference asked for", () => {
          const place = atSpaceRoot();
          const move = place.cd(`/@estuary/${HANDLE}@user`);
          if (move.kind !== "space-by-name") throw new Error("not handed on");
          place.settle(move);
          expect(place.place.scope).toBe("user");
        });

        it("carries no route, so `..` leaves the piece for the root", () => {
          const place = inSlugs();
          const move = place.cd(`/@estuary/${HANDLE}`);
          if (move.kind !== "space-by-name") throw new Error("not handed on");
          place.settle(move);
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
            "position  /@did:key:z6MkConnectedSpace/board/topics/3\n" +
              "scope     @space",
          );
        });
      });
    });
  });
});
