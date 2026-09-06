/**
 * Unit tests for how the tokens after a verb divide into options and operands.
 *
 * The parse itself is `cf`'s — `parseFlags` is what `Command` reads a flag on
 * a `cf` line through — so what these cases pin is the composition around it:
 * which table the parse is handed, which of its three answers become the
 * operands and in what order, and what a refusal says past the parser's own
 * sentence. A case that looks as though it tests the parser is testing that
 * the parser is the one reading the line, which is the decision this module
 * carries.
 *
 * The predicate beside the parse is asked against the parse in every case that
 * uses it. Two readings of a token that disagreed would put a name on a
 * listing that `cd` no longer takes, and the pair is the only place that can
 * be seen.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type OptionReading,
  readOptions,
  readsAsOption,
  type VerbOption,
} from "../lib/shuttle/options.ts";

/** A verb that declares one option taking a value, for the cases that need one. */
const SELECT: VerbOption = { name: "select", type: "string" };

/** A verb that declares one option taking none. */
const ALL: VerbOption = { name: "all" };

/**
 * A verb that declares one option it requires, which is the shape the shared
 * help row has to answer over. A line leaving a required option out is refused
 * whole, and a line asking what a verb takes is exactly such a line, so this is
 * the only declaration under which the row's standalone half can be seen.
 */
const REQUIRED_SELECT: VerbOption = {
  name: "select",
  type: "string",
  required: true,
};

/**
 * Helper for the cases below, which is the operands `tokens` came back as, and
 * nothing where the reading was not a read.
 */
function operandsOf(reading: OptionReading): readonly string[] | undefined {
  return reading.kind === "read" ? reading.operands : undefined;
}

/**
 * Helper for the cases below, which is the reason `tokens` were refused for,
 * and nothing where they were not refused.
 */
function reasonOf(reading: OptionReading): string | undefined {
  return reading.kind === "refused" ? reading.reason : undefined;
}

describe("options", () => {
  describe("readOptions()", () => {
    it("returns every token as an operand where none opens with `-`", () => {
      expect(operandsOf(readOptions("get", ["topics/3", "title"])))
        .toEqual(["topics/3", "title"]);
    });

    it("returns `-` on its own as an operand", () => {
      expect(operandsOf(readOptions("cd", ["-"]))).toEqual(["-"]);
    });

    it("returns the operands in the order written, with an option between them removed", () => {
      expect(
        operandsOf(readOptions("get", ["a", "--select", "x", "b"], [SELECT])),
      ).toEqual(["a", "b"]);
    });

    it("returns a declared option's value under the name it was declared by", () => {
      const reading = readOptions("get", ["--select", "title"], [SELECT]);
      expect(reading.kind === "read" ? reading.options : undefined)
        .toEqual({ select: "title" });
    });

    it("returns a token after a bare `--` as an operand though it opens with `-`", () => {
      expect(operandsOf(readOptions("cd", ["--", "-x"]))).toEqual(["-x"]);
    });

    it("returns the operands before and after a bare `--` in the order written", () => {
      expect(operandsOf(readOptions("cd", ["a", "--", "-x"])))
        .toEqual(["a", "-x"]);
    });

    it("returns no operand for a bare `--` on its own, the token being the terminator", () => {
      expect(operandsOf(readOptions("cd", ["--"]))).toEqual([]);
    });

    it("returns a second `--` as an operand, only the first ending the options", () => {
      expect(operandsOf(readOptions("cd", ["--", "--"]))).toEqual(["--"]);
    });

    it("returns the help reading for `--help`, which no verb declared", () => {
      expect(readOptions("cd", ["--help"])).toEqual({ kind: "help" });
    });

    it("returns the help reading for `-h`", () => {
      expect(readOptions("cd", ["-h"])).toEqual({ kind: "help" });
    });

    it("returns the help reading carrying no operand, where operands were written beside it", () => {
      expect(readOptions("cd", ["--help", "slugs"])).toEqual({ kind: "help" });
    });

    it("returns the help reading though a declared option the line leaves out is required", () => {
      expect(readOptions("get", ["--help"], [REQUIRED_SELECT]))
        .toEqual({ kind: "help" });
    });

    it("returns a refusal for `--help` written beside another option, which is what `cf` answers", () => {
      expect(
        reasonOf(readOptions("get", ["--select", "x", "--help"], [SELECT])),
      )
        .toContain('Option "--help" cannot be combined with other options.');
    });

    it("returns a refusal naming the option nobody declared", () => {
      expect(reasonOf(readOptions("get", ["-x"])))
        .toBe(
          'Unknown option "-x". Did you mean option "-h"? `get --help` says ' +
            "what `get` takes.",
        );
    });

    it("returns a refusal naming the verb's page, for the verb the line named", () => {
      expect(reasonOf(readOptions("ls", ["-x"])))
        .toContain("`ls --help` says what `ls` takes.");
    });

    it("returns a refusal where a declared option that takes a value is given none", () => {
      expect(reasonOf(readOptions("get", ["--select"], [SELECT])))
        .toContain('Missing value for option "--select".');
    });

    it("returns a refusal where a declared option that takes no value is given one", () => {
      expect(reasonOf(readOptions("verbs", ["--all=yes"], [ALL])))
        .toContain('Option "--all" doesn\'t take a value, but got "yes".');
    });

    it("returns a refusal for a token no option can be written as", () => {
      expect(reasonOf(readOptions("cd", ["---"])))
        .toContain('Invalid option "---".');
    });

    it("raises where the verb's table names a type nothing registered, which is no fact about the line", () => {
      expect(() =>
        readOptions("get", ["--pick", "1"], [{ name: "pick", type: "nope" }])
      ).toThrow('Unknown type "nope"');
    });
  });

  describe("readsAsOption()", () => {
    // The predicate and the parse have to agree about a token standing on its
    // own, since `operandForChild` offers a name on the predicate's word and
    // the dispatch reads that name back on the parse's. Each case asks both,
    // and what makes the pair a real question is that the two are separate
    // readings of one rule.

    const AGREEMENTS: readonly (readonly [string, boolean])[] = [
      ["-", false],
      ["", false],
      ["ordinary", false],
      ["..", false],
      ["x-", false],
      ["/@did:key:z6Mk/of:fid1:abcdefghijklmnop@space/-x", false],
      ["--", true],
      ["-x", true],
      ["-1", true],
      ["-h", true],
      ["---", true],
    ];

    for (const [token, option] of AGREEMENTS) {
      it(
        `returns \`${option}\` for \`${token}\`, which the parse ${
          option ? "keeps out of" : "returns among"
        } the operands`,
        () => {
          expect(readsAsOption(token)).toBe(option);
          const sole = operandsOf(readOptions("cd", [token]))?.[0];
          expect(sole).toBe(option ? undefined : token);
        },
      );
    }
  });
});
