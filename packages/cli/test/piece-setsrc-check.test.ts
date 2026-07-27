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
import type { PieceManager } from "@commonfabric/piece";
import type { PiecesController } from "@commonfabric/piece/ops";
import {
  assertSetSourceFlagCombination,
  checkPieceSourceFromCommand,
  formatPatternUpdateCheckReport,
  piece,
  reportIncompatibleSetSource,
  runSetSourceCommand,
  setPieceSourceFromCommand,
  type SetSourceCommandDependencies,
  SETSRC_INCOMPATIBLE_EXIT_CODE,
} from "../commands/piece.ts";
import { checkPiecePattern } from "../lib/piece.ts";

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

describe("cli piece setsrc — the action body", () => {
  // `runSetSourceCommand` IS the command: the chain only forwards to it. These
  // pin the routing, the rendering choice, and the process exit status, which
  // is what a script calling `setsrc` actually depends on.
  const baseOptions = {
    apiUrl: API_URL,
    space: SPACE,
    identity: "/tmp/test.key",
    piece: PIECE,
  };

  interface Recorded {
    printed: { message: unknown; json?: boolean }[];
    errors: string[];
    hints: string[];
    exits: number[];
  }

  const recorder = (): Recorded & { deps: SetSourceCommandDependencies } => {
    const recorded: Recorded = {
      printed: [],
      errors: [],
      hints: [],
      exits: [],
    };
    return {
      ...recorded,
      deps: {
        print: (message, options) =>
          recorded.printed.push({ message, json: options?.json }),
        printError: (message) => recorded.errors.push(message),
        printHint: (message) => recorded.hints.push(message),
        exit: (code: number) => {
          recorded.exits.push(code);
          return undefined as never;
        },
      },
    };
  };

  it("renders a compatible check as text and never touches the piece", async () => {
    const recorded = recorder();
    let mutated = false;

    await runSetSourceCommand(
      { ...baseOptions, check: true },
      "/repo/pattern.tsx",
      {
        ...recorded.deps,
        checkPieceSource: () => Promise.resolve(compatibleReport),
        setPieceSource: () => {
          mutated = true;
          return Promise.resolve(baseOptions);
        },
      },
    );

    expect(mutated).toBe(false);
    expect(recorded.exits).toEqual([]);
    expect(recorded.printed.length).toBe(1);
    expect(recorded.printed[0].json).toBe(false);
    expect(String(recorded.printed[0].message)).toContain("COMPATIBLE");
  });

  it("hands --json the report itself, not the rendered text", async () => {
    const recorded = recorder();

    await runSetSourceCommand(
      { ...baseOptions, check: true, json: true },
      "/repo/pattern.tsx",
      {
        ...recorded.deps,
        checkPieceSource: () => Promise.resolve(compatibleReport),
      },
    );

    expect(recorded.printed[0].json).toBe(true);
    expect(recorded.printed[0].message).toBe(compatibleReport);
  });

  it("exits 3 after reporting an incompatible check", async () => {
    const recorded = recorder();

    await runSetSourceCommand(
      { ...baseOptions, check: true },
      "/repo/pattern.tsx",
      {
        ...recorded.deps,
        checkPieceSource: () => Promise.resolve(incompatibleReport),
      },
    );

    // The verdict is printed BEFORE the exit: a caller reading stdout still
    // learns why, and a caller branching on status gets a distinct code.
    expect(String(recorded.printed[0].message)).toContain("INCOMPATIBLE");
    expect(recorded.exits).toEqual([SETSRC_INCOMPATIBLE_EXIT_CODE]);
  });

  it("refuses --json without --check before doing any work", async () => {
    const recorded = recorder();
    let checked = false;

    await expect(
      runSetSourceCommand({ ...baseOptions, json: true }, "/repo/pattern.tsx", {
        ...recorded.deps,
        checkPieceSource: () => {
          checked = true;
          return Promise.resolve(compatibleReport);
        },
      }),
    ).rejects.toThrow('"--json" is only available with "--check"');
    expect(checked).toBe(false);
  });

  it("applies the source and points at the next steps", async () => {
    const recorded = recorder();
    let applied: unknown;

    await runSetSourceCommand(baseOptions, "/repo/pattern.tsx", {
      ...recorded.deps,
      setPieceSource: (options, mainPath) => {
        applied = { piece: options.piece, mainPath };
        return Promise.resolve(baseOptions);
      },
    });

    expect(applied).toEqual({ piece: PIECE, mainPath: "/repo/pattern.tsx" });
    expect(String(recorded.printed[0].message)).toContain(
      `Updated source for piece ${PIECE}`,
    );
    expect(recorded.hints.join("\n")).toContain("NEXT STEPS");
    expect(recorded.exits).toEqual([]);
  });

  it("reports a refused update with exit 3 and rethrows", async () => {
    const recorded = recorder();
    const refusal = new PatternUpdateIncompatibleError(
      PIECE,
      incompatibleReport.blockers,
    );

    await expect(
      runSetSourceCommand(baseOptions, "/repo/pattern.tsx", {
        ...recorded.deps,
        setPieceSource: () => Promise.reject(refusal),
      }),
    ).rejects.toBe(refusal);

    expect(recorded.exits).toEqual([SETSRC_INCOMPATIBLE_EXIT_CODE]);
    expect(recorded.errors.join("\n")).toContain("The piece was NOT modified.");
    expect(recorded.errors.join("\n")).toContain("favorites");
  });

  it("lets an unrelated failure surface unchanged", async () => {
    const recorded = recorder();
    const failure = new Error("network down");

    await expect(
      runSetSourceCommand(baseOptions, "/repo/pattern.tsx", {
        ...recorded.deps,
        setPieceSource: () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure);

    // Nothing dressed it up as an incompatibility, and no status was claimed.
    expect(recorded.errors).toEqual([]);
    expect(recorded.exits).toEqual([]);
  });
});

describe("cli piece setsrc --check — the library boundary", () => {
  // `checkPiecePattern` is the read-only twin of `setPiecePattern`: it resolves
  // the same piece address the same way and asks the controller for a verdict,
  // without ever reaching a mutating call.
  const config = {
    apiUrl: API_URL,
    space: SPACE,
    identity: "/tmp/test.key",
    piece: "my-slug",
  };

  it("resolves the piece address and asks the controller for a verdict", async () => {
    const manager = { id: "manager" } as unknown as PieceManager;
    const calls: Record<string, unknown> = {};
    const controller = {
      checkPattern: (program: unknown) => {
        calls.checkedProgram = program;
        return Promise.resolve(compatibleReport);
      },
      setPattern: () => {
        throw new Error("a check must never mutate the piece");
      },
    };

    const report = await checkPiecePattern(
      config,
      { mainPath: "/repo/pattern.tsx", rootPath: "/repo" },
      {
        loadManager: (loaded) => {
          calls.loadedConfig = loaded;
          return Promise.resolve(manager);
        },
        resolvePieceAddress: (resolvingManager, token) => {
          calls.resolved = { sameManager: resolvingManager === manager, token };
          return Promise.resolve(PIECE);
        },
        createController: (controllerManager) => {
          calls.controllerManager = controllerManager;
          return {
            get: (
              id: string,
              start: boolean,
              _tx: unknown,
              scope: unknown,
            ) => {
              calls.got = { id, start, scope };
              return Promise.resolve(controller);
            },
          } as unknown as PiecesController;
        },
        getPinnedProgramFromFile: (programManager, entry) => {
          calls.pinned = { sameManager: programManager === manager, entry };
          return Promise.resolve({ main: "/repo/pattern.tsx", files: [] });
        },
      },
    );

    expect(report).toBe(compatibleReport);
    expect(calls.loadedConfig).toBe(config);
    expect(calls.resolved).toEqual({ sameManager: true, token: "my-slug" });
    expect(calls.controllerManager).toBe(manager);
    // The resolved address is what gets looked up, and the piece is fetched
    // WITHOUT starting it — a preflight must not run the pattern.
    expect(calls.got).toEqual({ id: PIECE, start: false, scope: undefined });
    expect(calls.pinned).toEqual({
      sameManager: true,
      entry: { mainPath: "/repo/pattern.tsx", rootPath: "/repo" },
    });
    expect(calls.checkedProgram).toEqual({
      main: "/repo/pattern.tsx",
      files: [],
    });
  });

  it("carries the piece scope through to the lookup", async () => {
    const manager = {} as unknown as PieceManager;
    let scope: unknown = "unset";

    await checkPiecePattern(
      { ...config, pieceScope: "user" },
      { mainPath: "/repo/pattern.tsx" },
      {
        loadManager: () => Promise.resolve(manager),
        resolvePieceAddress: () => Promise.resolve(PIECE),
        createController: () =>
          ({
            get: (
              _id: string,
              _start: boolean,
              _tx: unknown,
              cellScope: unknown,
            ) => {
              scope = cellScope;
              return Promise.resolve({
                checkPattern: () => Promise.resolve(incompatibleReport),
              });
            },
          }) as unknown as PiecesController,
        getPinnedProgramFromFile: () =>
          Promise.resolve({ main: "/repo/pattern.tsx", files: [] }),
      },
    );

    expect(scope).toBe("user");
  });
});
