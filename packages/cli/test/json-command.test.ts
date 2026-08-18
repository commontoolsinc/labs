import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { ConsoleMethod } from "@commonfabric/runner";

import {
  handlePieceRenderNoUi,
  pieceCallRawArgs,
  writePieceRenderStatus,
} from "../commands/piece.ts";
import {
  hasJsonArgument,
  reservesStdoutForCommandOutput,
  stderrConsoleHandler,
} from "../lib/json-output.ts";
import { safeStringify } from "../lib/render.ts";
import { cf, stripAnsi } from "./utils.ts";

describe("JSON command contracts", () => {
  it("redirects runtime consoles without changing the console method", () => {
    const output = stderrConsoleHandler({
      metadata: undefined,
      method: ConsoleMethod.Assert,
      args: [true],
    });

    expect(Array.isArray(output)).toBe(false);
    if (Array.isArray(output)) throw new Error("Expected redirected output");
    expect(output.method).toBe(ConsoleMethod.Assert);
    expect(output.target).toBeDefined();
    for (const method of Object.values(ConsoleMethod)) {
      expect(typeof output.target?.[method]).toBe("function");
    }
  });

  it("recognizes explicit and implicit JSON output modes", () => {
    expect(
      reservesStdoutForCommandOutput([
        "check",
        "file.ts",
        "--pattern-json",
      ]),
    ).toBe(true);
    expect(reservesStdoutForCommandOutput(["get", "path"]))
      .toBe(true);
    // The top-level spellings reserve stdout exactly as their piece
    // counterparts: get and call do, set does not.
    expect(reservesStdoutForCommandOutput(["get", "path"])).toBe(true);
    expect(reservesStdoutForCommandOutput(["call", "search"])).toBe(true);
    expect(reservesStdoutForCommandOutput(["set", "path"])).toBe(false);
    expect(reservesStdoutForCommandOutput(["piece", "get-label", "path"]))
      .toBe(true);
    expect(reservesStdoutForCommandOutput(["piece", "set-label", "path"]))
      .toBe(true);
    expect(
      reservesStdoutForCommandOutput([
        "piece",
        "call",
        "--piece",
        "example",
        "search",
        '{"query":"milk"}',
      ]),
    ).toBe(true);
    expect(
      reservesStdoutForCommandOutput([
        "piece",
        "--space",
        "test",
        "call",
        "search",
      ]),
    ).toBe(true);
    expect(
      reservesStdoutForCommandOutput([
        "piece",
        "ls",
        "--space",
        "call",
      ]),
    ).toBe(false);
    expect(reservesStdoutForCommandOutput(["piece", "new", "get"]))
      .toBe(false);
    expect(reservesStdoutForCommandOutput(["exec", "/tmp/search.tool"]))
      .toBe(true);
    expect(reservesStdoutForCommandOutput(["wish", "#profile"])).toBe(true);
    expect(reservesStdoutForCommandOutput(["piece", "inspect"])).toBe(false);
    expect(hasJsonArgument(["--json-file", "input.json"])).toBe(true);
    expect(safeStringify(undefined)).toBe("null");
    expect(JSON.parse(safeStringify({ count: 42n }))).toEqual({
      count: { $bigint: "42" },
    });
  });

  it("keeps the profiling marker off pattern JSON stdout", async () => {
    const env = { CF_PROFILE_DONE_MARKER: "profile finished" };
    const { code, stdout, stderr } = await cf(
      "check fixtures/check-json-no-evaluate.ts --pattern-json",
      { env },
    );

    expect(code).toBe(0);
    expect(stdout).toEqual(["1"]);
    expect(stderr.join("\n")).toContain("profile finished");

    const transformed = await cf(
      "check fixtures/check-json-no-evaluate.ts --show-transformed",
      { env },
    );
    expect(transformed.code).toBe(0);
    expect(transformed.stdout.join("\n")).not.toContain("profile finished");
    expect(transformed.stderr.join("\n")).toContain("profile finished");
  });

  it("keeps parser help off reserved stdout modes", async () => {
    for (
      const command of [
        "check --pattern-json --bogus fixtures/pow-5.tsx",
        "get --bogus",
        "piece get-label --bogus",
        "piece set-label --bogus",
        "piece --bogus get",
        "piece --bogus call",
        "wish --bogus #profile",
      ]
    ) {
      const { code, stdout, stderr } = await cf(command);

      expect(code).toBe(2);
      expect(stdout).toEqual([]);
      expect(stripAnsi(stderr.join("\n"))).toContain("Unknown option");
    }
  });

  it("does not reserve stdout for unrelated piece argument values", async () => {
    for (
      const command of [
        "piece new get --bogus",
        "piece ls --space call --bogus",
      ]
    ) {
      const { code, stdout, stderr } = await cf(command);

      expect(code).toBe(2);
      expect(stripAnsi(stdout.join("\n"))).toContain("Usage:");
      expect(stripAnsi(stderr.join("\n"))).toContain("Unknown option");
    }
  });

  it("rejects inspect html --json before opening the space", async () => {
    const { code, stdout, stderr } = await cf(
      "inspect html no-such-space --json",
    );

    expect(code).not.toBe(0);
    expect(stdout).toEqual([]);
    expect(stripAnsi(stderr.join("\n"))).toContain(
      'Option "--json" and the "html" command are mutually exclusive.',
    );
  });

  it("rejects inspect --json without a data subcommand", async () => {
    const { code, stdout, stderr } = await cf("inspect --json");

    expect(code).not.toBe(0);
    expect(stdout).toEqual([]);
    expect(stripAnsi(stderr.join("\n"))).toContain(
      'Option "--json" requires an inspect data subcommand.',
    );
  });

  it("rejects inspect graph --dot --json", async () => {
    const { code, stdout, stderr } = await cf(
      "inspect graph no-such-space --dot --json",
    );

    expect(code).not.toBe(0);
    expect(stdout).toEqual([]);
    expect(stripAnsi(stderr.join("\n"))).toContain(
      'Option "--dot" conflicts with option "--json".',
    );
  });

  it("rejects static human help when --json is present", async () => {
    const { code, stdout, stderr } = await cf("wish --json --help");

    expect(code).not.toBe(0);
    expect(stdout).toEqual([]);
    expect(stripAnsi(stderr.join("\n"))).toContain(
      'Option "--help" cannot be combined with other options.',
    );
  });

  it("documents redundant --json options on JSON-only reads", async () => {
    const pieceGet = await cf("get --help");
    const wish = await cf("wish --help");

    expect(pieceGet.code).toBe(0);
    expect(stripAnsi(pieceGet.stdout.join("\n"))).toContain("--json");
    expect(wish.code).toBe(0);
    expect(stripAnsi(wish.stdout.join("\n"))).toContain("--json");
  });

  it("rejects --json forwarded to fuse-daemon", async () => {
    for (
      const invocation of [
        "fuse-daemon /tmp/commonfabric-json-test --json",
        "fuse-daemon --json /tmp/commonfabric-json-test",
      ]
    ) {
      const { code, stdout, stderr } = await cf(invocation);

      expect(code).not.toBe(0);
      expect(stdout).toEqual([]);
      expect(stripAnsi(stderr.join("\n"))).toContain(
        'Unknown option "--json".',
      );
    }
  });
});

describe("call JSON arguments", () => {
  it("passes explicit JSON input through like cf exec", () => {
    expect(pieceCallRawArgs(["--json"], [])).toEqual(["--json"]);
    expect(pieceCallRawArgs(["--json", '{"query":"milk"}'], [])).toEqual([
      "--json",
      '{"query":"milk"}',
    ]);
  });

  it("retains positional JSON and delimited schema flags", () => {
    expect(pieceCallRawArgs(['{"query":"milk"}'], [])).toEqual([
      "--json",
      '{"query":"milk"}',
    ]);
    expect(pieceCallRawArgs([], ["--query", "milk"])).toEqual([
      "--query",
      "milk",
    ]);
  });

  it("rejects callable arguments on both sides of the delimiter", () => {
    expect(() => pieceCallRawArgs(["--json"], ["--query", "milk"])).toThrow(
      'Callable arguments cannot appear on both sides of "--".',
    );
  });

  it("reports mixed callable argument modes as a validation error", async () => {
    const { code, stdout, stderr } = await cf(
      "call --identity ./missing.key --api-url http://127.0.0.1:1 --space test --piece example search --json -- --query milk",
    );

    expect(code).toBe(2);
    expect(stdout).toEqual([]);
    expect(stripAnsi(stderr.join("\n"))).toContain(
      'Callable arguments cannot appear on both sides of "--".',
    );
    expect(stripAnsi(stderr.join("\n"))).not.toContain("pieceCallRawArgs");
  });

  it("writes watch status to stderr in JSON mode", () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => errors.push(args.join(" "));

    try {
      writePieceRenderStatus("Watching for changes", true);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    expect(logs).toEqual([]);
    expect(errors).toEqual(["Watching for changes"]);
  });

  it("treats a missing UI as an error in JSON mode", () => {
    expect(() =>
      handlePieceRenderNoUi(
        new Error("Piece example has no UI"),
        true,
      )
    ).toThrow("Piece example has no UI");
  });
});
