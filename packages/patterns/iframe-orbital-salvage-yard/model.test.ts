import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  createSalvageModule,
  isBookmarked,
  setBookmark,
  type WritableBookmarkMap,
} from "./model.ts";

const firstId = "123e4567-e89b-12d3-a456-426614174000";
const secondId = "123e4567-e89b-12d3-a456-426614174001";

describe("model", () => {
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
});
