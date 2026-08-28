import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import {
  publishRequestFor,
  SEED_DIRECTORY,
  seedMetadataFromSource,
  seedSourcePaths,
} from "../scripts/seed-pattern-index.ts";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));

const withDoc = (doc: string) => `${doc}\nexport const X = 1;\n`;

describe("seed-pattern-index", () => {
  describe("seedMetadataFromSource()", () => {
    it("takes the description from the first paragraph only, so the claim stays narrow", () => {
      const metadata = seedMetadataFromSource(
        "atom",
        withDoc(`/**
 * Counts a number up and down by a configurable step.
 *
 * Embed it as \`<Counter value={myCell} />\` and it mutates the host's cell.
 *
 * @hashtags counter, number
 * @keywords count, increment
 */`),
      );
      expect(metadata.description).toBe(
        "Counts a number up and down by a configurable step.",
      );
    });

    it("folds a description wrapped across lines back onto one line", () => {
      const metadata = seedMetadataFromSource(
        "atom",
        withDoc(`/**
 * Keeps a list of labeled amounts and shows
 * the formatted running total.
 *
 * @hashtags money
 * @keywords total
 */`),
      );
      expect(metadata.description).toBe(
        "Keeps a list of labeled amounts and shows the formatted running total.",
      );
    });

    it("reads hashtags and keywords, including a tag list wrapped across lines", () => {
      const metadata = seedMetadataFromSource(
        "atom",
        withDoc(`/**
 * Rolls a die.
 *
 * @hashtags dice, random, roll
 * @keywords roll dice, random number,
 * pick a number
 */`),
      );
      expect(metadata.hashtags).toEqual(["dice", "random", "roll"]);
      expect(metadata.keywords).toEqual([
        "roll dice",
        "random number",
        "pick a number",
      ]);
    });

    // An atom the index cannot be searched for is worth less than no atom, and
    // one described by a guess is worse than either, so each of these stops the
    // run before anything is published.
    it("refuses an atom with no doc comment", () => {
      expect(() => seedMetadataFromSource("atom", "export const X = 1;\n"))
        .toThrow(/no leading doc comment/);
    });

    it("refuses an atom whose doc comment opens straight into a tag", () => {
      expect(() =>
        seedMetadataFromSource(
          "atom",
          withDoc("/**\n * @hashtags a\n * @keywords b\n */"),
        )
      ).toThrow(/opens with no description/);
    });

    it("refuses an atom that declares no hashtags", () => {
      expect(() =>
        seedMetadataFromSource(
          "atom",
          withDoc("/**\n * Does a thing.\n *\n * @keywords b\n */"),
        )
      ).toThrow(/no @hashtags/);
    });

    it("refuses an atom that declares no keywords", () => {
      expect(() =>
        seedMetadataFromSource(
          "atom",
          withDoc("/**\n * Does a thing.\n *\n * @hashtags a\n */"),
        )
      ).toThrow(/no @keywords/);
    });
  });

  describe("seedSourcePaths()", () => {
    it("answers the atoms in a stable order and descends into no subdirectory", async () => {
      const paths = await seedSourcePaths(join(REPO_ROOT, SEED_DIRECTORY));
      const names = paths.map((path) => path.split("/").pop());
      expect(names).toEqual([...names].sort());
      // `demo/` holds the adopter that embeds the atoms; seeding it would
      // publish the demonstration as though it were a part.
      expect(names.some((name) => name === undefined)).toBe(false);
      expect(paths.every((path) => path.endsWith(".tsx"))).toBe(true);
      expect(paths.some((path) => path.includes("/demo/"))).toBe(false);
    });

    it("finds every atom this seed publishes", async () => {
      const paths = await seedSourcePaths(join(REPO_ROOT, SEED_DIRECTORY));
      expect(paths.map((path) => path.split("/").pop())).toEqual([
        "amount-ledger.tsx",
        "check-list.tsx",
        "counter.tsx",
        "dice-roller.tsx",
        "option-picker.tsx",
        "sortable-table.tsx",
      ]);
    });
  });

  describe("every seeded atom", () => {
    it("carries a description, hashtags and keywords the index can rank on", async () => {
      const paths = await seedSourcePaths(join(REPO_ROOT, SEED_DIRECTORY));
      for (const path of paths) {
        const name = path.split("/").pop() ?? path;
        const metadata = seedMetadataFromSource(
          name,
          await Deno.readTextFile(path),
        );
        expect(metadata.description.length).toBeGreaterThan(40);
        expect(metadata.hashtags.length).toBeGreaterThan(2);
        expect(metadata.keywords.length).toBeGreaterThan(4);
      }
    });
  });

  describe("publishRequestFor()", () => {
    const entry = {
      name: "counter",
      path: "/repo/packages/patterns/primitives/counter.tsx",
      metadata: {
        description: "Counts a number up and down.",
        hashtags: ["counter"],
        keywords: ["count"],
      },
      patternId: "abc123",
      program: {
        main: "/primitives/counter.tsx",
        files: [{ name: "/primitives/counter.tsx", contents: "export {};" }],
      },
      argumentSchema: { type: "object" },
      resultSchema: { type: "object" },
    };

    it("publishes under the compiled entry identity and carries the derived metadata", () => {
      const request = publishRequestFor(entry);
      expect(request.patternId).toBe("abc123");
      expect(request.description).toBe("Counts a number up and down.");
      expect(request.hashtags).toEqual(["counter"]);
      expect(request.keywords).toEqual(["count"]);
      expect(request.program.main).toBe("/primitives/counter.tsx");
    });

    // The seed sets no discoverability field: an omitted one is discoverable,
    // and these atoms are the curated tier.
    it("sets no field that would withhold an atom from discovery", () => {
      expect("nonDiscoverable" in publishRequestFor(entry)).toBe(false);
    });

    it("answers no dependencies for an atom that imports no published pattern", () => {
      expect(publishRequestFor(entry).dependencies).toEqual([]);
    });

    it("reports the published patterns an atom composes", () => {
      const request = publishRequestFor({
        ...entry,
        program: {
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: 'import X from "cf:pattern:dep-1";',
          }],
        },
      });
      expect(request.dependencies).toEqual(["dep-1"]);
    });
  });
});
