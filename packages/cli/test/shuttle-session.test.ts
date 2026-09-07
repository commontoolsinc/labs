/**
 * Unit tests for the session objects beside the place: what the last listing
 * numbered, what a rendering left for `more`, and which pieces the run has
 * started.
 *
 * The three are separate because different lines reset them, so the cases that
 * matter are the ones where one is written and another is asked. Nothing here
 * reads or writes outside itself, so every case drives the whole of it with no
 * connection, no place and no terminal.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { MemorySpace } from "@commonfabric/memory/interface";

import type { ListingHandles } from "../lib/shuttle/listing.ts";
import { placeAtSpaceRoot } from "../lib/shuttle/place.ts";
import { ShuttleSession } from "../lib/shuttle/session.ts";

const SPACE = "did:key:z6MkConnectedSpace" as MemorySpace;

/** Helper for the cases below, which is a table numbering `names`. */
function handles(...names: string[]): ListingHandles {
  return {
    place: placeAtSpaceRoot(SPACE),
    rows: names.map((name) => ({ name, kind: "value" as const })),
  };
}

describe("ShuttleSession", () => {
  describe("instance members", () => {
    describe("handles", () => {
      it("is nothing before a listing has run", () => {
        expect(new ShuttleSession().handles).toBeUndefined();
      });

      it("is what the last listing numbered", () => {
        const session = new ShuttleSession();
        const table = handles("title", "body");
        session.listed(table);
        expect(session.handles).toBe(table);
      });

      it("is the newest listing's, a listing resetting the numbering", () => {
        const session = new ShuttleSession();
        session.listed(handles("title"));
        session.listed(handles("topics"));
        expect(session.handles?.rows.map((row) => row.name))
          .toEqual(["topics"]);
      });

      it("survives a rendering that left lines behind", () => {
        // The two are reset by different lines, and this is the pair that
        // says so: a `get` past an `ls` takes over what `more` continues and
        // leaves `%3` naming the row the listing minted it for.

        const session = new ShuttleSession();
        session.listed(handles("title"));
        session.holding({ lines: ["a"] });
        expect(session.handles?.rows.map((row) => row.name))
          .toEqual(["title"]);
      });
    });

    describe("continuation", () => {
      it("is nothing before a rendering has run", () => {
        expect(new ShuttleSession().continuation).toBeUndefined();
      });

      it("is the lines a rendering left, in the order it composed them", () => {
        const session = new ShuttleSession();
        session.holding({ lines: ["a", "b"] });
        expect(session.continuation?.lines).toEqual(["a", "b"]);
      });

      it("carries the hint the rendering offered beside `more`", () => {
        const session = new ShuttleSession();
        session.holding({ lines: ["a"], hint: "--select narrows the read" });
        expect(session.continuation?.hint).toBe("--select narrows the read");
      });

      it("is nothing again once a rendering that fit whole has run", () => {
        // What stops `more` writing the tail of the line before last. A
        // rendering that fit says so by holding nothing, and the clearing is
        // that statement rather than an absence of one.

        const session = new ShuttleSession();
        session.holding({ lines: ["a"] });
        session.holding();
        expect(session.continuation).toBeUndefined();
      });

      it("survives a listing that numbered new rows", () => {
        // The other direction of the same split: numbering is reset by a
        // listing, and what `more` writes next is not.

        const session = new ShuttleSession();
        session.holding({ lines: ["a"] });
        session.listed(handles("title"));
        expect(session.continuation?.lines).toEqual(["a"]);
      });
    });
    describe("the warm set", () => {
      // What a start is remembered under is the whole of what decides which
      // piece runs, so the cases that matter are the ones where two warms
      // differ in one part of that key and are two pieces.

      it("says a piece nothing warmed has not been warmed", () => {
        expect(new ShuttleSession().hasWarmed("piece", "space")).toBe(false);
      });

      it("says a piece it recorded has been", () => {
        const session = new ShuttleSession();
        session.warmed("piece", "space");
        expect(session.hasWarmed("piece", "space")).toBe(true);
      });

      it("holds two pieces apart", () => {
        const session = new ShuttleSession();
        session.warmed("one", "space");
        expect(session.hasWarmed("two", "space")).toBe(false);
      });

      it("holds two scopes under one piece apart", () => {
        // The same id under two scopes is two documents, so a start under one
        // says nothing about the other.

        const session = new ShuttleSession();
        session.warmed("piece", "space");
        expect(session.hasWarmed("piece", "session")).toBe(false);
      });

      it("asks about the piece alone, whatever path reached it", () => {
        // What warms is a piece. The path an operand walked decided *which*
        // piece by being resolved, and by the time a start is recorded that
        // question is answered — so two lines writing two fields of one piece
        // ask one question and get one answer.

        const session = new ShuttleSession();
        session.warmed("piece", "space");
        expect(session.hasWarmed("piece", "space")).toBe(true);
      });

      it("survives a listing and a continuation, which reset the other two", () => {
        // A piece started stays started for the life of the process, so
        // nothing resets this one.

        const session = new ShuttleSession();
        session.warmed("piece", "space");
        session.listed(handles("title"));
        session.holding();
        expect(session.hasWarmed("piece", "space")).toBe(true);
      });
    });
  });
});
