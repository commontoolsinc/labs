import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { bytesToLines, cf, checkStderr, stripAnsi } from "./utils.ts";
import { Console as RuntimeConsole } from "@commonfabric/runner";
import { createRuntime, serializeMainExport } from "../lib/dev.ts";

describe("cli check", () => {
  it("rejects main exports that do not serialize as JSON", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => serializeMainExport({ default: 1n })).toThrow(
      "Main export not serializable.",
    );
    expect(() => serializeMainExport({ default: circular })).toThrow(
      "Main export not serializable.",
    );
    expect(() =>
      serializeMainExport({
        default: {
          toJSON: () => {
            throw new Error("serialization failed");
          },
          toString: () => "[object Object]",
        },
      })
    ).toThrow("Main export not serializable.");
  });

  it("keeps serialization callbacks off JSON stdout", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalStdoutWrite = Deno.stdout.writeSync;
    const originalStderrWrite = Deno.stderr.writeSync;
    Deno.stdout.writeSync = (bytes: Uint8Array) => {
      stdout.push(new TextDecoder().decode(bytes));
      return bytes.length;
    };
    Deno.stderr.writeSync = (bytes: Uint8Array) => {
      stderr.push(new TextDecoder().decode(bytes));
      return bytes.length;
    };

    const runtime = await createRuntime({ consoleToStderr: true });
    try {
      const sandboxConsole = new RuntimeConsole(runtime.harness);
      const serialized = serializeMainExport({
        default: {
          toJSON() {
            sandboxConsole.log("check JSON serialized");
            Promise.resolve().then(() =>
              sandboxConsole.log("check JSON serialization deferred")
            );
            return 1;
          },
        },
      });
      await Promise.resolve();

      expect(serialized).toBe("1");
    } finally {
      await runtime.dispose();
      Deno.stdout.writeSync = originalStdoutWrite;
      Deno.stderr.writeSync = originalStderrWrite;
    }

    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("check JSON serialized");
    expect(stderr.join("")).toContain("check JSON serialization deferred");
  });

  it("Executes a package", async () => {
    const { code, stdout, stderr } = await cf(
      "check fixtures/pow-5.tsx --pattern-json",
    );
    checkStderr(stderr);
    expect(stdout[stdout.length - 1]).toBe("25");
    expect(code).toBe(0);
  });

  it("Runs a pattern with commonfabric+3P modules", async () => {
    const { code, stdout, stderr } = await cf(
      "check fixtures/3p-modules.tsx --pattern-json",
    );
    checkStderr(stderr);
    expect(JSON.parse(stdout.join("\n")).argumentSchema).toBeTruthy();
    expect(code).toBe(0);
  });

  it("Generates output file with the compiled module bodies", async () => {
    const temp = await Deno.makeTempFile();
    const { code, stdout, stderr } = await cf(
      `check fixtures/pattern.tsx --no-run --output ${temp}`,
    );
    checkStderr(stderr);
    expect(stdout.length).toBe(0);
    expect(code).toBe(0);
    const rendered = bytesToLines(await Deno.readFile(temp));
    // Concatenated per-module compiled bodies, each headed by its
    // content-addressed specifier.
    expect(rendered[0]).toMatch(/^\/\/ cf:module\//);
    expect(rendered.some((line) => line.includes('"use strict"'))).toBe(true);
  });

  it("Uses default export when no --main-export specified", async () => {
    const { code, stdout, stderr } = await cf(
      "check fixtures/named-export.tsx --pattern-json",
    );
    checkStderr(stderr);
    const output = JSON.parse(stdout.join("\n"));
    expect(output.result.message).toBe("from default export");
    expect(code).toBe(0);
  });

  it("Uses specified named export with --main-export", async () => {
    const { code, stdout, stderr } = await cf(
      "check fixtures/named-export.tsx --main-export myNamedPattern --pattern-json",
    );
    checkStderr(stderr);
    const output = JSON.parse(stdout.join("\n"));
    // Named export uses cell reference, so check the argument schema
    expect(output.argumentSchema.default.message).toBe("from named export");
    // Also verify mainExport was set correctly in program
    expect(output.program.mainExport).toBe("myNamedPattern");
    expect(code).toBe(0);
  });

  it("Produces no output on success by default", async () => {
    const { code, stdout, stderr } = await cf("check fixtures/pow-5.tsx");
    checkStderr(stderr);
    expect(stdout.length).toBe(0);
    expect(code).toBe(0);
  });

  it("Resolves imports with --root flag", async () => {
    const { code, stdout, stderr } = await cf(
      "check --root fixtures fixtures/pow-5.tsx --pattern-json",
    );
    checkStderr(stderr);
    expect(stdout[stdout.length - 1]).toBe("25");
    expect(code).toBe(0);
  });

  it("prints compiled module bodies as a structured JSON result", async () => {
    const { code, stdout, stderr } = await cf(
      "check fixtures/check-json-no-evaluate.ts --json",
    );
    checkStderr(stderr);

    const result = JSON.parse(stdout.join("\n"));
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe("fixtures/check-json-no-evaluate.ts");
    expect(result.files[0].output).toContain('"use strict"');
    expect(code).toBe(0);

    const evaluated = await cf(
      "check fixtures/check-json-no-evaluate.ts --pattern-json",
    );
    expect(evaluated.code).toBe(0);
    expect(evaluated.stdout).toEqual(["1"]);
    expect(stripAnsi(evaluated.stderr.join("\n"))).toContain(
      "check JSON evaluated",
    );
    expect(stripAnsi(evaluated.stderr.join("\n"))).toContain(
      "check JSON deferred",
    );
  });

  it("rejects conflicting stdout modes", async () => {
    for (
      const flags of [
        "--json --show-transformed",
        "--json --pattern-json",
        "--show-transformed --pattern-json",
      ]
    ) {
      const { code, stderr } = await cf(
        `check fixtures/pow-5.tsx ${flags}`,
      );
      expect(code).not.toBe(0);
      expect(stripAnsi(stderr.join("\n"))).toContain("conflicts with option");
    }
  });

  it("does not print transformed output when any input fails", async () => {
    const { code, stdout, stderr } = await cf(
      "check fixtures/pow-5.tsx fixtures/no-such-pattern.tsx --show-transformed --no-run",
    );

    expect(code).not.toBe(0);
    expect(stdout).toEqual([]);
    expect(stripAnsi(stderr.join("\n"))).toContain("no-such-pattern.tsx");
  });

  it("does not evaluate input while showing transformed output", async () => {
    const { code, stdout, stderr } = await cf(
      "check fixtures/check-json-no-evaluate.ts --show-transformed",
    );

    checkStderr(stderr);
    expect(code).toBe(0);
    expect(stdout).not.toContain("check JSON evaluated");
    expect(stdout.join("\n")).toContain('console.log("check JSON evaluated")');
  });

  it("does not print pattern JSON when any input fails", async () => {
    const { code, stdout, stderr } = await cf(
      "check fixtures/check-json-no-evaluate.ts fixtures/no-such-pattern.tsx --pattern-json",
    );

    expect(code).not.toBe(0);
    expect(stdout).toEqual([]);
    expect(stripAnsi(stderr.join("\n"))).toContain("check JSON evaluated");
    expect(stripAnsi(stderr.join("\n"))).toContain("check JSON deferred");
    expect(stripAnsi(stderr.join("\n"))).toContain("no-such-pattern.tsx");
  });

  it("surfaces fabric imports without a space as a CLI compile error", async () => {
    const { code, stdout, stderr } = await cf(
      "check fixtures/fabric-import.tsx --no-run",
    );
    const renderedStderr = stripAnsi(stderr.join("\n"));

    expect(code).not.toBe(0);
    expect(stdout.length).toBe(0);
    expect(renderedStderr).toContain(
      "fabric imports require a space context (options.fabricImports)",
    );
    expect(renderedStderr).not.toContain("Could not resolve");
  });
});
