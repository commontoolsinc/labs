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
  parseBatchBlobs,
  parseIndexRecords,
  scan,
} from "./check-control-characters.ts";

/** Helper for the tests below, which makes a git repo holding one tracked file. */
async function git(root: string, ...args: string[]): Promise<void> {
  const { success, stderr } = await new Deno.Command("git", {
    args,
    cwd: root,
    stdout: "null",
    stderr: "piped",
  }).output();
  assert(success, `git ${args.join(" ")}: ${new TextDecoder().decode(stderr)}`);
}

/** Stages a file whose contents changed after the repo was made. */
async function gitAdd(root: string, name: string): Promise<void> {
  await git(root, "add", name);
}

async function fixtureRepo(
  name: string,
  contents: string,
  options: { autocrlf?: boolean } = {},
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "check-control-characters-" });
  await git(root, "init", "-q");
  await Deno.writeTextFile(join(root, name), contents);
  await git(root, "add", name);
  if (options.autocrlf) {
    // Set AFTER staging, so the blob holds LF and only the checkout converts.
    // Materialized straight from the index rather than through a commit: the
    // conversion this reproduces happens on checkout either way, and a commit
    // would need an author identity that a CI runner has no reason to carry.
    await git(root, "config", "core.autocrlf", "true");
    await Deno.remove(join(root, name));
    await git(root, "checkout-index", "-f", "-a");
  }
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

  describe("parseIndexRecords()", () => {
    it("returns the blob id and path of each record", () => {
      expect(
        parseIndexRecords(
          "100644 abc123 0\ttasks/a.ts\x00100644 def456 0\tb.md\x00",
        ),
      ).toEqual([["abc123", "tasks/a.ts"], ["def456", "b.md"]]);
    });

    it("keeps a path containing a space", () => {
      expect(parseIndexRecords("100644 abc123 0\tdocs/a b.ts\x00"))
        .toEqual([["abc123", "docs/a b.ts"]]);
    });

    it("declines a record with no path separator", () => {
      // Guessing at a malformed record would attribute a violation to the
      // wrong file, which is worse than reading one file fewer.
      expect(parseIndexRecords("100644 abc123 0 no-tab-here\x00")).toEqual([]);
    });
  });

  describe("parseBatchBlobs()", () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

    it("slices each blob by the size its header declares", () => {
      const blobs = parseBatchBlobs(
        encode("abc blob 2\nhi\ndef blob 3\nbye\n"),
        2,
      );
      expect(blobs.map(decode)).toEqual(["hi", "bye"]);
    });

    it("keeps content that contains its own record separator", () => {
      // The reason the size is read rather than scanned for: a blob may hold
      // the very newline that ends its record.
      expect(parseBatchBlobs(encode("abc blob 3\na\nb\n"), 1).map(decode))
        .toEqual(["a\nb"]);
    });

    it("stops at a header carrying no size", () => {
      // Continuing past one would slice every following blob at the wrong
      // offset and report violations against the wrong files.
      expect(parseBatchBlobs(encode("abc missing\ndef blob 2\nhi\n"), 2))
        .toEqual([]);
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

    it("judges the stored blob, not what the checkout materialized", async () => {
      // With `core.autocrlf=true` git writes a stored LF blob into the working
      // tree as CRLF. Scanning the working tree would report a carriage return
      // in source nobody wrote one in — a verdict that depends on the reader's
      // git config rather than on the repository.
      const root = await fixtureRepo(
        "subject.ts",
        "const a = 1;\nconst b = 2;\n",
        { autocrlf: true },
      );
      const materialized = await Deno.readFile(join(root, "subject.ts"));
      expect(materialized.includes(0x0d)).toBe(true);
      expect(await scan(root)).toEqual([]);
    });

    it("skips a governed file whose stored bytes are not UTF-8", async () => {
      // The extension governs, but the contents may still not decode. A file
      // this check cannot read is one it cannot judge, not a violation.
      const root = await fixtureRepo("subject.ts", "placeholder\n");
      await Deno.writeFile(
        join(root, "subject.ts"),
        new Uint8Array([0xff, 0xfe, 0x41, 0x0a]),
      );
      await gitAdd(root, "subject.ts");
      expect(await scan(root)).toEqual([]);
    });

    it("throws when git cannot list the tree", async () => {
      // A directory that is not a repository. Reporting nothing here would be
      // a gate that silently passes over everything it was meant to read.
      const root = await Deno.makeTempDir({ prefix: "check-control-not-git-" });
      await expect(scan(root)).rejects.toThrow("git ls-files failed");
    });
  });
});
