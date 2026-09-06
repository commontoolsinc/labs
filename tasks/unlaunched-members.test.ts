import { expect } from "@std/expect";
import * as path from "@std/path";
import { describe, it } from "@std/testing/bdd";
import {
  parseUnlaunchedMembers,
  readUnlaunchedMembers,
  UNLAUNCHED_MEMBERS_FILE,
  writeUnlaunchedMembers,
} from "./unlaunched-members.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "unlaunched-members-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

describe("unlaunched-members", () => {
  describe("parseUnlaunchedMembers()", () => {
    it("returns one member per line", () => {
      expect(parseUnlaunchedMembers("./packages/shell\n./tasks\n")).toEqual([
        "./packages/shell",
        "./tasks",
      ]);
    });

    it("returns no members for empty content", () => {
      expect(parseUnlaunchedMembers("")).toEqual([]);
      expect(parseUnlaunchedMembers("\n\n")).toEqual([]);
    });

    it("returns each member without its surrounding whitespace", () => {
      expect(parseUnlaunchedMembers("  ./packages/shell  \n\n\t./tasks\n"))
        .toEqual(["./packages/shell", "./tasks"]);
    });
  });

  describe("writeUnlaunchedMembers()", () => {
    it("writes no file for an empty member list", async () => {
      await withTempDir(async (dir) => {
        await writeUnlaunchedMembers(dir, []);
        expect([...Deno.readDirSync(dir)]).toEqual([]);
      });
    });

    it("writes the members into a directory that does not exist yet", async () => {
      await withTempDir(async (dir) => {
        const target = path.join(dir, "coverage", "raw");
        await writeUnlaunchedMembers(target, ["./packages/shell"]);
        expect(
          await Deno.readTextFile(path.join(target, UNLAUNCHED_MEMBERS_FILE)),
        ).toBe("./packages/shell\n");
      });
    });

    it("removes a record an earlier write left when there are no members", async () => {
      await withTempDir(async (dir) => {
        await writeUnlaunchedMembers(dir, ["./packages/shell"]);
        await writeUnlaunchedMembers(dir, []);
        expect([...Deno.readDirSync(dir)]).toEqual([]);
      });
    });

    it("reports a removal failure that is not a missing record", async () => {
      await withTempDir(async (dir) => {
        // A non-empty directory where the record should be is not an absent
        // record, and removing it fails with something other than `NotFound`.
        const occupied = path.join(dir, UNLAUNCHED_MEMBERS_FILE);
        await Deno.mkdir(occupied);
        await Deno.writeTextFile(path.join(occupied, "entry"), "");
        await expect(writeUnlaunchedMembers(dir, [])).rejects.toThrow();
      });
    });
  });

  describe("readUnlaunchedMembers()", () => {
    it("returns the members a write to the same directory left", async () => {
      await withTempDir(async (dir) => {
        await writeUnlaunchedMembers(dir, ["./packages/shell", "./tasks"]);
        expect(await readUnlaunchedMembers(dir)).toEqual([
          "./packages/shell",
          "./tasks",
        ]);
      });
    });

    it("returns no members for a directory holding no record", async () => {
      await withTempDir(async (dir) => {
        expect(await readUnlaunchedMembers(dir)).toEqual([]);
      });
    });

    it("reports a read failure that is not a missing record", async () => {
      await withTempDir(async (dir) => {
        // A directory where the record should be is not an absent record, and
        // reading it fails with something other than `NotFound`.
        await Deno.mkdir(path.join(dir, UNLAUNCHED_MEMBERS_FILE));
        await expect(readUnlaunchedMembers(dir)).rejects.toThrow();
      });
    });
  });
});
