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
    it("returns the space root with a trailing slash, and the scope", () => {
      expect(renderPlace(placeAtSpaceRoot(SPACE))).toBe(
        "position  /@did:key:z6MkConnectedSpace/\nscope     @space",
      );
    });

    it("returns a facet with a trailing slash", () => {
      expect(renderPlace(inSlugs().place)).toBe(
        "position  /@did:key:z6MkConnectedSpace/slugs/\nscope     @space",
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
                  facet: "slugs",
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
                  facet: "slugs",
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
                  facet: "slugs",
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

          it("refuses a rooted string that names no piece", () => {
            expect(atSpaceRoot().cd("/")).toEqual({
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
                  facet: "slugs",
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
              facet: "slugs",
            });
          });

          it("reads a segment inside a piece as data, `@` included", () => {
            const place = atPiece();
            place.cd("mail@example");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: "board",
              path: ["mail@example"],
              facet: "slugs",
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
              facet: "slugs",
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
              facet: "slugs",
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
