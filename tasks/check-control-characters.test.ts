/**
 * These pin a gate that fails CI, so it has to be exact in both directions.
 *
 * The cases that must NOT match carry most of the weight: a false positive
 * blocks a pull request over ordinary source, and the characters here are
 * invisible, so a reader cannot check the verdict by eye.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assert } from "@std/assert";
import { join } from "@std/path";
import {
  controlViolations,
  isGovernedPath,
  main,
  scan,
} from "./check-control-characters.ts";

/** Helper for the tests below, which makes a git repo holding one tracked file. */
async function fixtureRepo(name: string, contents: string): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "check-control-characters-" });
  const run = async (...args: string[]) => {
    const { success, stderr } = await new Deno.Command("git", {
      args,
      cwd: root,
      stdout: "null",
      stderr: "piped",
    }).output();
    assert(
      success,
      `git ${args.join(" ")}: ${new TextDecoder().decode(stderr)}`,
    );
  };
  await run("init", "-q");
  await Deno.writeTextFile(join(root, name), contents);
  await run("add", name);
  return root;
}

describe("check-control-characters", () => {
  describe("controlViolations()", () => {
    it("returns nothing for source that is only text and newlines", () => {
      expect(controlViolations("const a = 1;\nconst b = 2;\n")).toEqual([]);
    });

    it("returns nothing for an escape written as source characters", () => {
      // The whole point of the rule: this is the spelling it asks for, so it
      // has to read as clean. These are five ordinary characters.
      expect(controlViolations("const sep = `${a}\\x00${b}`;\n")).toEqual([]);
    });

    it("reports a literal NUL with the line it first appears on", () => {
      expect(controlViolations("a\nb\nconst s = \u0000;\n")).toEqual([
        { line: 3, code: 0x00, count: 1 },
      ]);
    });

    it("counts a codepoint once per file rather than once per occurrence", () => {
      // A CRLF file would otherwise report a finding per line and bury every
      // other file in the run.
      expect(controlViolations("a\r\nb\r\nc\r\n")).toEqual([
        { line: 1, code: 0x0d, count: 3 },
      ]);
    });

    it("reports a literal tab", () => {
      expect(controlViolations("const a = 1;\n\tconst b = 2;\n")).toEqual([
        { line: 2, code: 0x09, count: 1 },
      ]);
    });

    it("allows characters at or above 0x20, including non-ASCII", () => {
      expect(controlViolations('const s = "— ✓ é";\n')).toEqual([]);
    });
  });

  describe("isGovernedPath()", () => {
    it("governs the authored source extensions", () => {
      for (
        const path of [
          "tasks/a.ts",
          "packages/ui/b.tsx",
          "x.js",
          "y.jsx",
          "z.mjs",
          "deno.json",
          "deno.jsonc",
        ]
      ) {
        expect(isGovernedPath(path)).toBe(true);
      }
    });

    it("leaves fixtures and prose alone", () => {
      // Text by accident rather than by authorship: a control byte there may
      // be the data itself.
      for (
        const path of [
          "docs/README.md",
          "packages/piece/test/vintages/x.sqlite",
          "a.txt",
          "b.lcov",
        ]
      ) {
        expect(isGovernedPath(path)).toBe(false);
      }
    });

    it("leaves the vendored type declarations alone", () => {
      // Upstream ships them with CRLF; rewriting a vendored artifact for the
      // sake of a rule about our own source would be undone on re-vendoring.
      expect(isGovernedPath("packages/static/assets/types/es2023.d.ts"))
        .toBe(false);
    });
  });

  describe("scan()", () => {
    it("finds a literal NUL in a tracked source file", async () => {
      const root = await fixtureRepo("subject.ts", "const s = \u0000;\n");
      expect(await scan(root)).toEqual([
        { file: "subject.ts", line: 1, code: 0x00, count: 1 },
      ]);
    });

    it("ignores the same byte in a file it does not govern", async () => {
      const root = await fixtureRepo("subject.md", "prose \u0000 here\n");
      expect(await scan(root)).toEqual([]);
    });

    it("exits 1 and names the file when a violation stands", async () => {
      const root = await fixtureRepo("subject.ts", "const s = \u0000;\n");
      expect(await main(root)).toBe(1);
    });

    it("exits 0 for a clean tree", async () => {
      const root = await fixtureRepo("subject.ts", 'const s = "\\x00";\n');
      expect(await main(root)).toBe(0);
    });
  });
});
