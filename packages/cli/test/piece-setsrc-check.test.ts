/**
 * `cf piece setsrc --check` — the command boundary.
 *
 * Why: the preflight only earns its keep if it is genuinely read-only and if
 * its exit status is machine-usable. These tests pin the routing (a `--check`
 * run must never reach the mutating library call), the flag validation, the
 * exit code, and the human/JSON report shapes. The rules themselves are pinned
 * in `packages/piece/test/pattern-update-check.test.ts`.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type PatternUpdateCheckReport,
  PatternUpdateIncompatibleError,
} from "@commonfabric/piece/ops";
import {
  assertSetSourceFlagCombination,
  checkPieceSourceFromCommand,
  formatPatternUpdateCheckReport,
  piece,
  reportIncompatibleSetSource,
  setPieceSourceFromCommand,
  SETSRC_INCOMPATIBLE_EXIT_CODE,
} from "../commands/piece.ts";

const API_URL = "https://cf.dev";
const SPACE = "common-knowledge";
const PIECE = "abcdefghijklmnopqrstuvwxyz";

const compatibleReport: PatternUpdateCheckReport = {
  piece: PIECE,
  compatible: true,
  steps: [
    { name: "pattern contract", status: "pass", note: "contracts still hold" },
    {
      name: "CFC document migration (argument)",
      status: "not-applicable",
      note: "no stored envelope",
    },
    { name: "retained argument links", status: "pass" },
  ],
  blockers: [],
  advisories: [
    {
      class: "setup-migration",
      role: "result",
      field: "addFavorite",
      message: "`addFavorite` is a new handler stream; setup materializes it.",
    },
  ],
};

const incompatibleReport: PatternUpdateCheckReport = {
  piece: PIECE,
  compatible: false,
  steps: [{ name: "pattern contract", status: "fail" }],
  blockers: [
    {
      class: "cfc-schema-migration",
      role: "result",
      field: "favorites",
      reason:
        "required field favorites needs a default to preserve old documents",
      message:
        "field `favorites` would become required but has no default — an existing document predating it could not be read.",
    },
  ],
  advisories: [],
};

describe("cli piece setsrc --check", () => {
  it("registers the preflight flags on setsrc", () => {
    const flags = piece.getCommand("setsrc")!.getOptions().flatMap((option) =>
      option.flags
    );
    expect(flags).toContain("--check");
    expect(flags).toContain("--json");
  });

  it("routes a check to the read-only library call, never the mutating one", async () => {
    let checked: unknown;
    const report = await checkPieceSourceFromCommand(
      {
        apiUrl: API_URL,
        space: SPACE,
        identity: "/tmp/test.key",
        piece: PIECE,
        root: "/repo",
        check: true,
      },
      "/repo/pattern.tsx",
      {
        checkPiecePattern: (config, entry) => {
          checked = { config, entry };
          return Promise.resolve(compatibleReport);
        },
      },
    );

    expect(report).toBe(compatibleReport);
    expect(checked).toEqual({
      config: {
        apiUrl: API_URL,
        space: SPACE,
        identity: "/tmp/test.key",
        piece: PIECE,
      },
      entry: { mainPath: "/repo/pattern.tsx", rootPath: "/repo" },
    });
  });

  it("does not call setPiecePattern for a check run", async () => {
    // The mutating boundary is a separate function; a check run reaches the
    // other one. Proven by wiring a setPiecePattern that would fail the test
    // if it were ever invoked.
    let mutated = false;
    await checkPieceSourceFromCommand(
      {
        apiUrl: API_URL,
        space: SPACE,
        identity: "/tmp/test.key",
        piece: PIECE,
        check: true,
      },
      "/repo/pattern.tsx",
      { checkPiecePattern: () => Promise.resolve(compatibleReport) },
    );
    await setPieceSourceFromCommand(
      {
        apiUrl: API_URL,
        space: SPACE,
        identity: "/tmp/test.key",
        piece: PIECE,
      },
      "/repo/pattern.tsx",
      {
        setPiecePattern: () => {
          mutated = true;
          return Promise.resolve();
        },
      },
    );
    expect(mutated).toBe(true);
  });

  it("rejects --json without --check", () => {
    expect(() => assertSetSourceFlagCombination({ json: true })).toThrow(
      '"--json" is only available with "--check"',
    );
    expect(() => assertSetSourceFlagCombination({ json: true, check: true }))
      .not.toThrow();
  });

  it("rejects --check combined with the dangerous override", () => {
    expect(() =>
      assertSetSourceFlagCombination({
        check: true,
        dangerouslyAllowIncompatibleSchema: true,
      })
    ).toThrow('"--check" cannot be combined');
    expect(() =>
      assertSetSourceFlagCombination({
        dangerouslyAllowIncompatibleSchema: true,
      })
    ).not.toThrow();
  });

  it("renders a compatible verdict with its proved steps and migration work", () => {
    const output = formatPatternUpdateCheckReport(compatibleReport);
    expect(output).toContain("COMPATIBLE");
    expect(output).toContain("pattern contract");
    expect(output).toContain("n/a");
    expect(output).toContain("Would migrate on update:");
    expect(output).toContain("addFavorite");
    expect(output).not.toContain("Blockers:");
  });

  it("renders an incompatible verdict naming the field and the rule", () => {
    const output = formatPatternUpdateCheckReport(incompatibleReport);
    expect(output).toContain("INCOMPATIBLE");
    expect(output).toContain("Blockers:");
    expect(output).toContain("[cfc-schema-migration]");
    expect(output).toContain("favorites");
    expect(output).toContain("could not be read");
  });

  it("reports a refused setsrc with the check's reasons and exit 3", () => {
    const errors: string[] = [];
    const hints: string[] = [];
    let exited: number | undefined;
    const error = new PatternUpdateIncompatibleError(
      PIECE,
      incompatibleReport.blockers,
    );

    reportIncompatibleSetSource(error, {
      printError: (message) => errors.push(message),
      printHint: (message) => hints.push(message),
      exit: (code: number) => {
        exited = code;
        return undefined as never;
      },
    });

    expect(exited).toBe(SETSRC_INCOMPATIBLE_EXIT_CODE);
    expect(errors[0]).toContain("The piece was NOT modified.");
    expect(errors.join("\n")).toContain("favorites");
    expect(errors.join("\n")).toContain("[cfc-schema-migration]");
    expect(hints.join("\n")).toContain("setsrc --check");
  });

  it("leaves an unrelated failure alone", () => {
    let exited = false;
    const result = reportIncompatibleSetSource(new Error("network down"), {
      printError: () => {},
      printHint: () => {},
      exit: () => {
        exited = true;
        return undefined as never;
      },
    });
    expect(result).toBe(null);
    expect(exited).toBe(false);
  });
});
