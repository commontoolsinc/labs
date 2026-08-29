import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  canBeginDrag,
  createSalvageModule,
  dragDisposition,
  initializeGraphics,
  isBookmarked,
  ownsDrag,
  resolveSnapClaims,
  setBookmark,
  type WritableBookmarkMap,
} from "./model.ts";
import type { ModuleSnapClaim } from "./contract.ts";
import { findConnections } from "./geometry.ts";

const firstId = "123e4567-e89b-12d3-a456-426614174000";
const secondId = "123e4567-e89b-12d3-a456-426614174001";

describe("model", () => {
  describe("pointer drag ownership", () => {
    it("lets only the initiating pointer update and finish an active drag", () => {
      const active = { pointerId: 17 };

      expect(canBeginDrag(undefined)).toBe(true);
      expect(canBeginDrag(active)).toBe(false);
      expect(ownsDrag(active, 17)).toBe(true);
      expect(ownsDrag(active, 23)).toBe(false);
      expect(ownsDrag(undefined, 17)).toBe(false);
      expect(dragDisposition({ pointerId: 17, moved: true }, 23, false)).toBe(
        "ignore",
      );
      expect(dragDisposition({ pointerId: 17, moved: false }, 17, false)).toBe(
        "restore",
      );
      expect(dragDisposition({ pointerId: 17, moved: true }, 17, true)).toBe(
        "restore",
      );
      expect(dragDisposition({ pointerId: 17, moved: true }, 17, false)).toBe(
        "commit",
      );
    });
  });

  describe("initializeGraphics()", () => {
    it("surfaces and preserves a renderer bootstrap failure", () => {
      const failure = new Error("WebGL unavailable");
      const seen: unknown[] = [];

      expect(() =>
        initializeGraphics(() => {
          throw failure;
        }, (cause) => seen.push(cause))
      ).toThrow(failure);
      expect(seen).toEqual([failure]);
    });
  });

  describe("createSalvageModule()", () => {
    it("returns the same presentation and placement for one stable ID", () => {
      expect(createSalvageModule("cargo", firstId)).toEqual(
        createSalvageModule("cargo", firstId),
      );
    });

    it("returns distinct presentation and placement for concurrent same-kind additions", () => {
      const first = createSalvageModule("cargo", firstId);
      const second = createSalvageModule("cargo", secondId);

      expect(first.label).not.toBe(second.label);
      expect(first.transform.position).not.toEqual(second.transform.position);
    });
  });

  describe("setBookmark()", () => {
    it("preserves concurrent bookmarks written from the same stale snapshot", async () => {
      const values: Record<string, boolean> = {};
      const paths: string[] = [];
      const bookmarks: WritableBookmarkMap = {
        key(moduleId) {
          paths.push(moduleId);
          return {
            set(value) {
              values[moduleId] = value;
              return Promise.resolve();
            },
          };
        },
      };

      await Promise.all([
        setBookmark(bookmarks, firstId, true),
        setBookmark(bookmarks, secondId, true),
      ]);

      expect(paths).toEqual([firstId, secondId]);
      expect(values).toEqual({ [firstId]: true, [secondId]: true });
    });

    it("writes `false` at the selected module path when removing a bookmark", async () => {
      const values: Record<string, boolean> = { [firstId]: true };
      const bookmarks: WritableBookmarkMap = {
        key(moduleId) {
          return {
            set(value) {
              values[moduleId] = value;
              return Promise.resolve();
            },
          };
        },
      };

      await setBookmark(bookmarks, firstId, false);

      expect(isBookmarked(values, firstId)).toBe(false);
    });
  });

  describe("resolveSnapClaims()", () => {
    it("gives one deterministic winner to concurrent claims on one lock", () => {
      const anchor = createSalvageModule("hub", "anchor");
      anchor.transform.position = [0, 1.2, 0];
      const first = createSalvageModule("cargo", "mover-a");
      const second = createSalvageModule("cargo", "mover-b");
      first.transform.position = [8, 1.2, 0];
      second.transform.position = [-8, 1.2, 0];
      const claims: Record<string, ModuleSnapClaim> = {
        [first.id]: {
          id: "claim-a",
          movingConnectorId: "port-lock",
          targetModuleId: anchor.id,
          targetConnectorId: "east-lock",
          transform: { position: [5, 1.2, 0], rotationQuarterTurns: 0 },
        },
        [second.id]: {
          id: "claim-b",
          movingConnectorId: "port-lock",
          targetModuleId: anchor.id,
          targetConnectorId: "east-lock",
          transform: { position: [5, 1.2, 0], rotationQuarterTurns: 0 },
        },
      };

      const firstWins = { "anchor::east-lock": "claim-a" };
      const secondWins = { "anchor::east-lock": "claim-b" };
      const forward = resolveSnapClaims(
        [anchor, first, second],
        claims,
        firstWins,
      );
      const reversed = resolveSnapClaims(
        [second, first, anchor],
        claims,
        firstWins,
      );

      expect(
        forward.find((module) => module.id === first.id)?.transform.position,
      )
        .toEqual([5, 1.2, 0]);
      expect(
        forward.find((module) => module.id === second.id)?.transform.position,
      )
        .toEqual([-8, 1.2, 0]);
      expect(
        reversed.find((module) => module.id === first.id)?.transform.position,
      )
        .toEqual([5, 1.2, 0]);
      expect(
        reversed.find((module) => module.id === second.id)?.transform.position,
      )
        .toEqual([-8, 1.2, 0]);
      const connections = findConnections(forward);
      expect(connections).toHaveLength(1);
      expect(
        connections.flatMap((connection) => [
          `${connection.first.moduleId}:${connection.first.id}`,
          `${connection.second.moduleId}:${connection.second.id}`,
        ]),
      ).toContain("anchor:east-lock");
      const switched = resolveSnapClaims(
        [anchor, first, second],
        claims,
        secondWins,
      );
      expect(
        switched.find((module) => module.id === first.id)?.transform.position,
      ).toEqual([8, 1.2, 0]);
      expect(
        switched.find((module) => module.id === second.id)?.transform.position,
      ).toEqual([5, 1.2, 0]);
      expect(findConnections(switched)).toHaveLength(1);
    });
  });
});
