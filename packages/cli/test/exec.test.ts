import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, join } from "@std/path";
import type { JSONSchema } from "@commonfabric/api";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  type ExecCommandSpec,
  normalizeCallableInputForExecution,
  parseExecArgs,
  renderExecHelp,
  renderExecHelpJson,
  renderPieceCallHelp,
  resolveExecInvocation,
  resolveParsedExecInput,
} from "../lib/exec-schema.ts";
import {
  executeMountedCallableFile,
  resolveMountedCallableFile,
} from "../lib/exec.ts";
import { writeMountState } from "../lib/fuse.ts";
import { CF_RUNTIME_ERROR_LOG } from "../lib/callable.ts";
import { cf, isIgnorableDenoWarningLine } from "./utils.ts";

function makeSpec(
  callableKind: "handler" | "tool",
  inputSchema: JSONSchema,
  outputSchemaSummary?: JSONSchema,
): ExecCommandSpec {
  return {
    callableKind,
    defaultVerb: callableKind === "handler" ? "invoke" : "run",
    inputSchema,
    outputSchemaSummary,
  };
}

describe("parseExecArgs", () => {
  it("defaults handlers to invoke and tools to run when flags are provided", () => {
    const handler = parseExecArgs(
      makeSpec("handler", {
        type: "object",
        properties: { query: { type: "string" } },
      }),
      ["--query", "milk"],
    );
    const tool = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: { query: { type: "string" } },
      }),
      ["--query", "milk"],
    );

    expect(handler.verb).toBe("invoke");
    expect(handler.showHelp).toBe(false);
    expect(handler.input).toEqual({ query: "milk" });
    expect(tool.verb).toBe("run");
    expect(tool.showHelp).toBe(false);
    expect(tool.input).toEqual({ query: "milk" });
  });

  it("treats top-level --help as command help", () => {
    const result = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          help: { type: "string" },
          query: { type: "string" },
        },
      }),
      ["--help"],
    );

    expect(result.verb).toBe("run");
    expect(result.showHelp).toBe(true);
    expect(result.showHelpJson).toBe(false);
    expect(result.input).toEqual({});
  });

  it("treats top-level --help with a value as a schema field when help exists", () => {
    const result = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          help: { type: "string" },
          query: { type: "string" },
        },
      }),
      ["--help", "details", "--query", "milk"],
    );

    expect(result.showHelp).toBe(false);
    expect(result.input).toEqual({
      help: "details",
      query: "milk",
    });
  });

  it("reserves standalone --help even when help is a boolean schema field", () => {
    const result = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          help: { type: "boolean" },
        },
      }),
      ["--help"],
    );

    expect(result.showHelp).toBe(true);
    expect(result.input).toEqual({});
  });

  it("still accepts explicit boolean help values", () => {
    const result = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          help: { type: "boolean" },
        },
      }),
      ["--help=true"],
    );

    expect(result.showHelp).toBe(false);
    expect(result.input).toEqual({ help: true });
  });

  it("supports --help --json for machine-readable schema help", () => {
    const result = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      }),
      ["--help", "--json"],
    );

    expect(result.showHelp).toBe(true);
    expect(result.showHelpJson).toBe(true);
    expect(result.input).toEqual({});
  });

  it("parses primitive flags including booleans", () => {
    const result = parseExecArgs(
      makeSpec("handler", {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer" },
          verbose: { type: "boolean" },
          exact: { type: "boolean" },
        },
      }),
      [
        "invoke",
        "--query",
        "oat milk",
        "--limit",
        "2",
        "--verbose",
        "--exact=false",
      ],
    );

    expect(result.input).toEqual({
      query: "oat milk",
      limit: 2,
      verbose: true,
      exact: false,
    });
  });

  it("parses arrays and objects from JSON strings", () => {
    const result = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          filters: {
            type: "object",
            properties: { fresh: { type: "boolean" } },
          },
          tags: {
            type: "array",
            items: { type: "string" },
          },
        },
      }),
      [
        "run",
        "--filters",
        '{"fresh":true}',
        "--tags",
        '["grocery","weekly"]',
      ],
    );

    expect(result.input).toEqual({
      filters: { fresh: true },
      tags: ["grocery", "weekly"],
    });
  });

  it("supports non-object schemas through --value and inline object schemas through --json", () => {
    const primitive = parseExecArgs(
      makeSpec("handler", { type: "number" }),
      ["--value", "42"],
    );
    const json = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          query: { type: "string" },
          filters: {
            type: "object",
            properties: { fresh: { type: "boolean" } },
          },
        },
      }),
      ["--json", '{"query":"oat milk","filters":{"fresh":true}}'],
    );

    expect(primitive.input).toBe(42);
    expect(primitive.readJsonFromStdin).toBe(false);
    expect(json.input).toEqual({
      query: "oat milk",
      filters: { fresh: true },
    });
  });

  it("preserves inline --json payloads for object schemas without CLI shape enforcement", () => {
    const result = parseExecArgs(
      makeSpec("handler", {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      }),
      ["--json", '["not-an-object"]'],
    );

    expect(result.usedJsonInput).toBe(true);
    expect(result.input).toEqual(["not-an-object"]);
  });

  it("treats bare --json as stdin input mode", () => {
    const result = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      }),
      ["--json"],
    );

    expect(result.readJsonFromStdin).toBe(true);
    expect(result.input).toBeUndefined();
  });

  it("supports file-based value and JSON input modes", () => {
    const valueFile = parseExecArgs(
      makeSpec("handler", { type: "string" }),
      ["--value-file", "/tmp/content.md"],
    );
    const jsonFile = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      }),
      ["--json-file", "/tmp/input.json"],
    );

    expect(valueFile.inputFile).toEqual({
      format: "text",
      path: "/tmp/content.md",
    });
    expect(valueFile.readTextFromStdin).toBe(false);
    expect(jsonFile.inputFile).toEqual({
      format: "json",
      path: "/tmp/input.json",
    });
    expect(jsonFile.readJsonFromStdin).toBe(false);
  });

  it("supports reading primitive values from stdin via --value-file -", () => {
    const result = parseExecArgs(
      makeSpec("handler", { type: "string" }),
      ["--value-file", "-"],
    );

    expect(result.readTextFromStdin).toBe(true);
    expect(result.readJsonFromStdin).toBe(false);
    expect(result.input).toBeUndefined();
  });

  it('treats "--json -" as the stdin sentinel for non-object schemas', () => {
    const result = parseExecArgs(
      makeSpec("handler", { type: "number" }),
      ["--json", "-"],
    );

    expect(result.readJsonFromStdin).toBe(true);
    expect(result.usedJsonInput).toBe(true);
    expect(result.input).toBeUndefined();
  });

  it('treats "--json -" as the stdin sentinel for object schemas', () => {
    const result = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      }),
      ["--json", "-"],
    );

    expect(result.readJsonFromStdin).toBe(true);
    expect(result.usedJsonInput).toBe(true);
    expect(result.input).toBeUndefined();
  });

  it("preserves omitted non-object inputs as undefined", () => {
    const primitive = parseExecArgs(
      makeSpec("handler", { type: "number" }),
      ["invoke"],
    );

    expect(primitive.input).toBeUndefined();
  });

  it("rejects invoking handlers with no arguments unless invoke is explicit", () => {
    expect(() =>
      parseExecArgs(
        makeSpec("handler", {
          type: "string",
        }),
        [],
      )
    ).toThrow(
      /Handler requires input/i,
    );
  });

  it("allows handlers with empty object inputs to invoke without arguments", () => {
    const result = parseExecArgs(
      makeSpec("handler", {
        type: "object",
        properties: {},
      }),
      [],
    );

    expect(result.verb).toBe("invoke");
    expect(result.input).toEqual({});
  });

  it("allows schema-less handlers to invoke without arguments", () => {
    const result = parseExecArgs(
      makeSpec("handler", { asCell: ["stream"] } as JSONSchema),
      [],
    );

    expect(result.verb).toBe("invoke");
    expect(result.input).toBeUndefined();
  });

  it("allows invoke alone for handlers whose inputs are all optional", () => {
    const result = parseExecArgs(
      makeSpec("handler", {
        type: "object",
        properties: {
          message: { type: "string" },
        },
      }),
      ["invoke"],
    );

    expect(result.verb).toBe("invoke");
    expect(result.input).toEqual({});
  });

  it("rejects mixed --json and generated flags", () => {
    expect(() =>
      parseExecArgs(
        makeSpec("tool", {
          type: "object",
          properties: { query: { type: "string" } },
        }),
        ["--json", '{"query":"tea"}', "--query", "coffee"],
      )
    ).toThrow(/--json cannot be combined with generated flags/i);
  });

  it("reports readable required-field, enum, and unknown-flag errors", () => {
    const spec = makeSpec("tool", {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["fast", "slow"] },
        query: { type: "string" },
      },
      required: ["query"],
    });

    expect(() => parseExecArgs(spec, ["--mode", "fast"])).toThrow(
      /Missing required flag --query/i,
    );
    expect(() => parseExecArgs(spec, ["--query", "tea", "--mode", "invalid"]))
      .toThrow(/Invalid value for --mode/i);
    expect(() => parseExecArgs(spec, ["--query", "tea", "--unknown", "value"]))
      .toThrow(/Unknown flag --unknown/i);
  });
});

describe("parseExecArgs edge cases", () => {
  it("validates every generated flag value by its schema type", () => {
    const spec = makeSpec("tool", {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        count: { type: "number" },
        whole: { type: "integer" },
        items: { type: "array" },
        config: { type: "object" },
        nothing: { type: "null" },
      },
    });

    expect(() => parseExecArgs(spec, ["--enabled=maybe"])).toThrow(
      /expected true or false/,
    );
    expect(() => parseExecArgs(spec, ["--count", "NaN"])).toThrow(
      /expected number/,
    );
    expect(() => parseExecArgs(spec, ["--whole", "1.5"])).toThrow(
      /expected integer/,
    );
    expect(() => parseExecArgs(spec, ["--items", "{"])).toThrow(
      /Invalid JSON/,
    );
    expect(() => parseExecArgs(spec, ["--items", "{}"])).toThrow(
      /expected array JSON/,
    );
    expect(() => parseExecArgs(spec, ["--config", "[]"])).toThrow(
      /expected object JSON/,
    );
    expect(() => parseExecArgs(spec, ["--nothing", "false"])).toThrow(
      /expected null/,
    );
    expect(parseExecArgs(spec, ["--nothing", "null"]).input).toEqual({
      nothing: null,
    });
  });

  it("rejects conflicting object-input modes at the point they conflict", () => {
    const spec = makeSpec("tool", {
      type: "object",
      properties: {
        query: { type: "string" },
        enabled: { type: "boolean" },
      },
    });

    expect(() => parseExecArgs(spec, ["value"])).toThrow(
      /Unexpected argument value/,
    );
    expect(() => parseExecArgs(spec, ["--json", "--query", "tea"])).toThrow(
      /cannot be combined/,
    );
    expect(() => parseExecArgs(spec, ["--query", "tea", "--json", "{}"]))
      .toThrow(/cannot be combined/);
    expect(() => parseExecArgs(spec, ["--json", "{}", "--json", "{}"]))
      .toThrow(/only be provided once/);
    expect(() =>
      parseExecArgs(spec, ["--query", "tea", "--json-file", "input.json"])
    ).toThrow(/json-file cannot be combined/);
    expect(() =>
      parseExecArgs(spec, ["--json", "{}", "--json-file", "input.json"])
    ).toThrow(/only be provided once/);
    expect(() => parseExecArgs(spec, ["--json-file"])).toThrow(
      /Missing value/,
    );
    expect(parseExecArgs(spec, ["--json-file", "-"])).toMatchObject({
      readJsonFromStdin: true,
      usedJsonInput: true,
    });
    expect(parseExecArgs(spec, ["--no-enabled"]).input).toEqual({
      enabled: false,
    });
    expect(() => parseExecArgs(spec, ["--no-query"])).toThrow(
      /Unknown flag/,
    );
    expect(() => parseExecArgs(spec, ["--query"])).toThrow(/Missing value/);
  });

  it("handles each non-object input mode and its errors", () => {
    const booleanSpec = makeSpec("tool", { type: "boolean" });
    const stringSpec = makeSpec("tool", { type: "string" });

    expect(parseExecArgs(booleanSpec, ["--value", "true"]).input).toBe(true);
    expect(() => parseExecArgs(stringSpec, ["--value", "one", "extra"]))
      .toThrow(/Unexpected argument extra/);
    expect(() => parseExecArgs(stringSpec, ["--other", "value"])).toThrow(
      /Unknown flag/,
    );
    expect(() => parseExecArgs(stringSpec, ["--json", "--other"])).toThrow(
      /cannot be combined/,
    );
    expect(parseExecArgs(stringSpec, ["--json", '"value"']).input).toBe(
      "value",
    );
    expect(parseExecArgs(stringSpec, ["--json-file", "-"])).toMatchObject({
      readJsonFromStdin: true,
      usedJsonInput: true,
    });
    expect(parseExecArgs(stringSpec, ["--json-file", "input.json"]).inputFile)
      .toEqual({ format: "json", path: "input.json" });
  });

  it("validates explicit verbs and explicit-verb help", () => {
    const spec = makeSpec("tool", { type: "object", properties: {} });

    expect(() => parseExecArgs(spec, ["invoke"])).toThrow(/Invalid verb/);
    expect(() => parseExecArgs(spec, ["--help", "extra"])).toThrow(
      /Unknown flag --help/,
    );
    expect(parseExecArgs(spec, ["run", "--help"])).toMatchObject({
      verb: "run",
      showHelp: true,
      showHelpJson: false,
    });
    expect(parseExecArgs(spec, ["run", "--help", "--json"]))
      .toMatchObject({ showHelp: true, showHelpJson: true });
    expect(() => parseExecArgs(spec, ["run", "--help", "extra"])).toThrow(
      /Unknown flag --help/,
    );
  });
});

describe("resolveParsedExecInput edge cases", () => {
  it("reports empty and malformed JSON read from stdin", async () => {
    const spec = makeSpec("tool", { type: "object", properties: {} });
    const parsed = parseExecArgs(spec, ["--json"]);

    await expect(resolveParsedExecInput(spec, parsed, {
      readTextInput: () => Promise.resolve("  \n"),
    })).rejects.toThrow(/Expected JSON/);
    await expect(resolveParsedExecInput(spec, parsed, {
      readTextInput: () => Promise.resolve("not json"),
    })).rejects.toThrow(/Invalid JSON/);
  });

  it("parses primitive stdin and handles terminal or empty implicit input", async () => {
    const primitive = makeSpec("handler", { type: "boolean" });
    const parsed = parseExecArgs(primitive, ["--value-file", "-"]);
    expect(
      await resolveParsedExecInput(primitive, parsed, {
        readTextInput: () => Promise.resolve("false"),
      }),
    ).toBe(false);

    const optional = makeSpec("handler", {
      type: "object",
      properties: {},
    });
    expect(
      (await resolveExecInvocation(optional, [], {
        isStdinTerminal: () => true,
      })).input,
    ).toEqual({});
    expect(
      (await resolveExecInvocation(optional, [], {
        isStdinTerminal: () => false,
        readTextInput: () => Promise.resolve(""),
      })).input,
    ).toEqual({});
  });

  it("normalizes only object inputs for tools with a string help field", () => {
    const spec = makeSpec("tool", {
      type: "object",
      properties: { help: { type: "string" } },
    });

    expect(normalizeCallableInputForExecution(spec, null)).toBe(null);
    expect(normalizeCallableInputForExecution(spec, ["value"])).toEqual([
      "value",
    ]);
    expect(normalizeCallableInputForExecution(spec, { query: "tea" })).toEqual(
      { query: "tea", help: "" },
    );
  });
});

describe("resolveParsedExecInput", () => {
  it("reads text payloads from files for primitive inputs", async () => {
    const spec = makeSpec("handler", { type: "string" });
    const parsed = parseExecArgs(spec, ["--value-file", "/tmp/content.md"]);

    const input = await resolveParsedExecInput(spec, parsed, {
      readTextFile: (path) => {
        expect(path).toBe("/tmp/content.md");
        return Promise.resolve("# Title\n\nLine 2");
      },
    });

    expect(input).toBe("# Title\n\nLine 2");
  });

  it("reads JSON payloads from files for object inputs", async () => {
    const spec = makeSpec("tool", {
      type: "object",
      properties: {
        detail: {
          type: "object",
          properties: {
            value: { type: "string" },
          },
        },
      },
      required: ["detail"],
    });
    const parsed = parseExecArgs(spec, ["--json-file", "/tmp/input.json"]);

    const input = await resolveParsedExecInput(spec, parsed, {
      readTextFile: (path) => {
        expect(path).toBe("/tmp/input.json");
        return Promise.resolve(
          '{"detail":{"value":"Use `cat` to read files"}}',
        );
      },
    });

    expect(input).toEqual({
      detail: { value: "Use `cat` to read files" },
    });
  });

  it("reads --json stdin payloads for object inputs without CLI shape enforcement", async () => {
    const spec = makeSpec("handler", {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    });
    const parsed = parseExecArgs(spec, ["--json"]);

    const input = await resolveParsedExecInput(spec, parsed, {
      readTextInput: () => Promise.resolve('["not-an-object"]'),
    });

    expect(input).toEqual(["not-an-object"]);
  });

  it("reads --json-file payloads for object inputs without CLI shape enforcement", async () => {
    const spec = makeSpec("handler", {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    });
    const parsed = parseExecArgs(spec, ["--json-file", "/tmp/input.json"]);

    const input = await resolveParsedExecInput(spec, parsed, {
      readTextFile: (path) => {
        expect(path).toBe("/tmp/input.json");
        return Promise.resolve('["not-an-object"]');
      },
    });

    expect(input).toEqual(["not-an-object"]);
  });
});

describe("renderExecHelp", () => {
  it("renders flag-first tool help without schema prose", () => {
    const help = renderExecHelp(
      "/tmp/search.tool",
      makeSpec(
        "tool",
        {
          type: "object",
          properties: {
            query: { type: "string" },
            help: { type: "string" },
          },
          required: ["query"],
        },
        {
          type: "object",
          properties: {
            results: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      ),
    );

    expect(help).toContain("Usage:");
    expect(help).toContain("cf exec /tmp/search.tool [run] --query <string>");
    expect(help).toContain("cf exec /tmp/search.tool [run] --json");
    expect(help).toContain("cf exec /tmp/search.tool [run] --json-file <path>");
    expect(help).toContain("cf exec /tmp/search.tool [run] --help --json");
    expect(help).toContain("--query <string>");
    expect(help).toContain('Optional input field named "help".');
    expect(help).toContain("Read the full input object from stdin.");
    expect(help).toContain("Read the full input object from a JSON file.");
    expect(help).toContain("Show full schema details as JSON.");
    expect(help).toContain("Output:");
    expect(help).toContain("JSON on success:");
    expect(help).toContain("results");
    expect(help).not.toContain("Callable:");
    expect(help).not.toContain("Input schema:");
  });

  it("renders direct mounted-file usage when called via shebang", () => {
    const help = renderExecHelp(
      "./legacyWrite.handler",
      makeSpec("handler", {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      }),
      { invocationStyle: "direct" },
    );

    expect(help).toContain("./legacyWrite.handler [invoke] --message <string>");
    expect(help).toContain("./legacyWrite.handler [invoke] --help");
    expect(help).not.toContain("cf exec ./legacyWrite.handler");
    expect(help).toContain("No output on success.");
    expect(help).toContain(
      "Alternatively, write JSON to this file to invoke the handler.",
    );
  });

  it("mentions explicit invoke for handlers whose inputs are all optional", () => {
    const help = renderExecHelp(
      "./legacyWrite.handler",
      makeSpec("handler", {
        type: "object",
        properties: {},
      }),
      { invocationStyle: "direct" },
    );

    expect(help).toContain("./legacyWrite.handler invoke");
    expect(help).toContain(
      "Invoke alone will call the handler without any inputs.",
    );
  });

  it("renders schema-less handlers as void no-input callables", () => {
    const help = renderExecHelp(
      "./onAddContact.handler",
      makeSpec("handler", { asCell: ["stream"] } as JSONSchema),
      { invocationStyle: "direct" },
    );

    expect(help).toContain("Input type:");
    expect(help).toContain("  void");
    expect(help).toContain("./onAddContact.handler");
    expect(help).toContain(
      "Invoke alone will call the handler without any inputs.",
    );
  });

  it("quotes direct mounted-file usage when the path contains spaces", () => {
    const help = renderExecHelp(
      "/tmp/Fuse Exec Fixture/search.tool",
      makeSpec("tool", {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      }),
      { invocationStyle: "direct" },
    );

    expect(help).toContain(
      "'/tmp/Fuse Exec Fixture/search.tool' [run] --query <string>",
    );
    expect(help).toContain("'/tmp/Fuse Exec Fixture/search.tool' [run] --help");
  });

  it("renders primitive callable flags through --value and --json", () => {
    const help = renderExecHelp(
      "/tmp/number.handler",
      makeSpec("handler", { type: "number" }),
    );

    expect(help).toContain(
      "cf exec /tmp/number.handler [invoke] --value <number>",
    );
    expect(help).toContain(
      "cf exec /tmp/number.handler [invoke] --value-file <path>",
    );
    expect(help).toContain("cf exec /tmp/number.handler [invoke] --json");
    expect(help).toContain(
      "cf exec /tmp/number.handler [invoke] --json-file <path>",
    );
    expect(help).toContain("--value <number>");
    expect(help).toContain("--value-file <path>");
    expect(help).toContain("Read the full input value as JSON from stdin.");
    expect(help).toContain(
      "Read the value from a UTF-8 file. Use - for stdin.",
    );
  });

  it("renders boolean help fields without colliding with command help", () => {
    const help = renderExecHelp(
      "/tmp/search.tool",
      makeSpec("tool", {
        type: "object",
        properties: {
          help: { type: "boolean" },
        },
      }),
    );

    expect(help).toContain("--help=<boolean> | --no-help");
    expect(help).toContain("Boolean. Use --help=true or --no-help.");
  });

  it("renders typed flags, schema details, deep shapes, and empty output objects", () => {
    const help = renderExecHelp(
      "/tmp/complex.tool",
      makeSpec(
        "tool",
        {
          type: "object",
          properties: {
            enabled: {
              type: "boolean",
              default: true,
              description: "Enables the operation.",
            },
            count: { type: "integer" },
            settings: { type: "object", properties: {} },
            items: { type: "array", items: { type: "string" } },
            nothing: { type: "null" },
            mode: { enum: ["fast", "safe"] },
            choice: { anyOf: [{ type: "string" }, { type: "number" }] },
            deep: {
              type: "object",
              properties: {
                one: {
                  type: "object",
                  properties: {
                    two: {
                      type: "object",
                      properties: {
                        three: {
                          type: "object",
                          properties: { four: { type: "string" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          required: ["enabled", "count", "settings", "items", "nothing"],
        },
        { type: "object", properties: {} },
      ),
    );

    expect(help).toContain("--enabled | --no-enabled");
    expect(help).toContain("--count <integer>");
    expect(help).toContain("--settings <json-object>");
    expect(help).toContain("--items <json-array>");
    expect(help).toContain("--nothing <null>");
    expect(help).toContain('Allowed: "fast" | "safe".');
    expect(help).toContain("Default: true.");
    expect(help).toContain("Enables the operation.");
    expect(help).toContain("choice?: string | number");
    expect(help).toContain("{...}");
    expect(help).toContain("JSON on success.");
  });
});

describe("renderExecHelpJson", () => {
  it("renders machine-readable schema details", () => {
    const schema = JSON.parse(
      renderExecHelpJson(
        makeSpec(
          "tool",
          {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
          {
            type: "object",
            properties: {
              summary: { type: "string" },
            },
          },
        ),
      ),
    );

    expect(schema.callableKind).toBe("tool");
    expect(schema.inputSchema.required).toEqual(["query"]);
    expect(schema.outputSchema.properties.summary.type).toBe("string");
  });
});

describe("renderPieceCallHelp", () => {
  it("renders piece-call help with top-level help lines and JSON input", () => {
    const help = renderPieceCallHelp(
      "cf piece call ... search",
      makeSpec(
        "tool",
        {
          type: "object",
          properties: {
            query: { type: "string" },
            help: { type: "string" },
          },
          required: ["query"],
        },
        {
          type: "object",
          properties: {
            summary: { type: "string" },
          },
        },
      ),
    );

    expect(help).toContain("cf piece call ... search --help");
    expect(help).toContain("cf piece call ... search --help --json");
    expect(help).toContain("cf piece call ... search <json>");
    expect(help).toContain(
      "cf piece call ... search -- [run] --query <string>",
    );
    expect(help).toContain("JSON input:");
    expect(help).toContain("Pass inline JSON as the next argument");
    expect(help).toContain("query: string");
    expect(help).toContain("help?: string");
    expect(help).toContain("Flags after `--`:");
    expect(help).not.toContain("Read the full input object from stdin.");
    expect(help).not.toContain("cf piece call ... search -- [run] --help");
  });

  it("renders bare usage for schema-less handler piece-call help", () => {
    const help = renderPieceCallHelp(
      "cf piece call ... onAddContact",
      makeSpec("handler", { asCell: ["stream"] } as JSONSchema),
    );

    expect(help).toContain("cf piece call ... onAddContact");
    expect(help).toContain("cf piece call ... onAddContact -- invoke");
    expect(help).toContain(
      "Invoke alone will call the handler without any inputs.",
    );
  });
});

describe("exec command user-facing errors", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await Deno.makeTempDir({ prefix: "cf-exec-cli-test-" });
  });

  afterEach(async () => {
    await Deno.remove(tmpDir, { recursive: true });
  });

  it("prints readable errors without a raw stack trace", async () => {
    const missingPath = join(tmpDir, "missing.handler");
    const { code, stdout, stderr } = await cf(`exec ${missingPath}`);

    expect(code).toBe(1);
    expect(stdout).toEqual([]);

    const relevantStderr = stderr.filter((line) =>
      !line.includes("deno run ") && !isIgnorableDenoWarningLine(line)
    );

    expect(relevantStderr).toEqual([
      `Path is not within a mounted cf fuse filesystem: ${missingPath}`,
    ]);
    expect(relevantStderr.join("\n")).not.toMatch(/\n\s*at\s+/);
    expect(relevantStderr.join("\n")).not.toMatch(
      /executeMountedCallableFile|resolveMountedCallableFile/,
    );
  });
});

describe("mounted callable resolution and execution", () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(async () => {
    tmpDir = await Deno.makeTempDir({ prefix: "cf-exec-test-" });
    stateDir = join(tmpDir, "state");
  });

  afterEach(async () => {
    await Deno.remove(tmpDir, { recursive: true });
  });

  it("rejects non-mounted paths", async () => {
    await expect(
      resolveMountedCallableFile(join(tmpDir, "outside.handler"), {
        stateDir,
      }),
    ).rejects.toThrow(/not within a mounted cf fuse filesystem/i);
  });

  it("rejects mounted non-callable files", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/title",
      pieceId: "of:piece-123",
    });
    await writeLiveMountState(stateDir, mountpoint);

    await expect(
      resolveMountedCallableFile(filePath, {
        stateDir,
      }),
    ).rejects.toThrow(/not a mounted callable file/i);
  });

  it("rejects suffix-only callable paths whose cell kind does not match", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/title.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "title",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    await expect(
      resolveMountedCallableFile(filePath, {
        stateDir,
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
      }),
    ).rejects.toThrow(/does not resolve to a handler/i);
  });

  it("rejects fabricated mounted callable paths whose file is missing", async () => {
    const mountpoint = join(tmpDir, "mount");
    const pieceDir = join(mountpoint, "home/pieces/notes-2");
    const filePath = join(pieceDir, "result", "title.handler");
    await Deno.mkdir(join(pieceDir, "result"), { recursive: true });
    await Deno.writeTextFile(
      join(pieceDir, "meta.json"),
      JSON.stringify({
        id: "of:piece-123",
        entityId: "of:piece-123",
        name: "Fixture Piece",
      }),
    );
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const delays: number[] = [];
    await expect(
      resolveMountedCallableFile(filePath, {
        stateDir,
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        delay: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/mounted callable file not found/i);

    // One bounded wait to outlast the directory listing cache, then failure.
    // The macOS NFS client serves cached listings for up to ~3s, so the
    // wait must exceed that for the recheck to reach the daemon.
    expect(delays.length).toBe(1);
    expect(delays[0]).toBeGreaterThan(3000);
  });

  it("tolerates transient mounted callable ENOENT during FUSE invalidation", async () => {
    const mountpoint = join(tmpDir, "mount");
    const pieceDir = join(mountpoint, "home/pieces/notes-2");
    const filePath = join(pieceDir, "result", "search.tool");
    await Deno.mkdir(join(pieceDir, "result"), { recursive: true });
    await Deno.writeTextFile(filePath, "");
    await Deno.writeTextFile(
      join(pieceDir, "meta.json"),
      JSON.stringify({
        id: "of:piece-123",
        entityId: "of:piece-123",
        name: "Fixture Piece",
      }),
    );
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
        resultSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
      },
    });
    await writeLiveMountState(stateDir, mountpoint);

    // The file exists, but stat reports NotFound the way a stale FUSE-T
    // kernel cache does while the bridge rebuilds the prop subtree. The
    // resolver falls back to the parent directory listing, which names
    // the file.
    const statCalls: string[] = [];
    const resolved = await resolveMountedCallableFile(filePath, {
      stateDir,
      loadManager: () => Promise.resolve(harness.manager),
      loadPiece: () => Promise.resolve(harness.piece),
      stat: (path) => {
        statCalls.push(path);
        return Promise.reject(
          new Deno.errors.NotFound(`stat '${path}': invalidated`),
        );
      },
    });

    expect(statCalls.length).toBe(1);
    expect(statCalls[0].endsWith(join("result", "search.tool"))).toBe(true);
    expect(resolved.absPath).toBe(filePath);
    expect(resolved.pieceId).toBe("of:piece-123");
  });

  it("consults the parent listing again after a stale cached listing", async () => {
    const mountpoint = join(tmpDir, "mount");
    const pieceDir = join(mountpoint, "home/pieces/notes-2");
    const filePath = join(pieceDir, "result", "search.tool");
    await Deno.mkdir(join(pieceDir, "result"), { recursive: true });
    await Deno.writeTextFile(filePath, "");
    await Deno.writeTextFile(
      join(pieceDir, "meta.json"),
      JSON.stringify({
        id: "of:piece-123",
        entityId: "of:piece-123",
        name: "Fixture Piece",
      }),
    );
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
        resultSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
      },
    });
    await writeLiveMountState(stateDir, mountpoint);

    // stat reports NotFound and the first parent listing is served from a
    // cache that predates the file; only the listing taken after the cache
    // validity window names it.
    const readDirCalls: string[] = [];
    const delays: number[] = [];
    const resolved = await resolveMountedCallableFile(filePath, {
      stateDir,
      loadManager: () => Promise.resolve(harness.manager),
      loadPiece: () => Promise.resolve(harness.piece),
      stat: (path) =>
        Promise.reject(new Deno.errors.NotFound(`stat '${path}': invalidated`)),
      readDir: (path) => {
        readDirCalls.push(path);
        return readDirCalls.length === 1
          ? (async function* (): AsyncIterable<Deno.DirEntry> {})()
          : Deno.readDir(path);
      },
      delay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    expect(readDirCalls.length).toBe(2);
    expect(delays.length).toBe(1);
    expect(resolved.absPath).toBe(filePath);
    expect(resolved.pieceId).toBe("of:piece-123");
  });

  it("resolves the correct mount by longest-prefix lookup", async () => {
    const parentMount = join(tmpDir, "mount");
    const nestedMount = join(parentMount, "nested");
    const filePath = await createMountedFile(nestedMount, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
        resultSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
      },
      toolResult: { ok: true },
    });

    await writeLiveMountState(stateDir, parentMount, "http://localhost:8000");
    await writeLiveMountState(stateDir, nestedMount, "http://localhost:9000");

    const resolved = await resolveMountedCallableFile(filePath, {
      stateDir,
      loadManager: () => Promise.resolve(harness.manager),
      loadPiece: () => Promise.resolve(harness.piece),
    });

    expect(resolved.mount.entry.mountpoint).toBe(nestedMount);
    expect(resolved.mount.entry.apiUrl).toBe("http://localhost:9000");
  });

  it("uses sibling meta.json to recover the canonical piece id for de-duped names", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:canonical-piece",
      patternRef: {
        identity: "A".repeat(43),
        symbol: "default",
        source: {
          ref: `cf:pattern:${"A".repeat(43)}`,
          repository: "https://github.com/commontoolsinc/labs",
          entry: "/notes/note.tsx",
          origin: "file:///repo/notes/note.tsx",
        },
      },
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:canonical-piece",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
        resultSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
      },
      toolResult: { ok: true },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const resolved = await resolveMountedCallableFile(filePath, {
      stateDir,
      loadManager: () => Promise.resolve(harness.manager),
      loadPiece: () => Promise.resolve(harness.piece),
    });

    expect(resolved.pieceId).toBe("of:canonical-piece");
    expect(resolved.pieceMeta.patternRef).toEqual({
      identity: "A".repeat(43),
      symbol: "default",
      source: {
        ref: `cf:pattern:${"A".repeat(43)}`,
        repository: "https://github.com/commontoolsinc/labs",
        entry: "/notes/note.tsx",
        origin: "file:///repo/notes/note.tsx",
      },
    });
  });

  it("resolves callable paths under both pieces and entities", async () => {
    const mountpoint = join(tmpDir, "mount");
    const piecesPath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const entitiesPath = await createMountedFile(mountpoint, {
      relativePath: "home/entities/of:piece-123/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const piecesResolved = await resolveMountedCallableFile(piecesPath, {
      stateDir,
      loadManager: () => Promise.resolve(harness.manager),
      loadPiece: () => Promise.resolve(harness.piece),
    });
    const entitiesResolved = await resolveMountedCallableFile(entitiesPath, {
      stateDir,
      loadManager: () => Promise.resolve(harness.manager),
      loadPiece: () => Promise.resolve(harness.piece),
    });

    expect(piecesResolved.callablePath.rootKind).toBe("pieces");
    expect(entitiesResolved.callablePath.rootKind).toBe("entities");
    expect(piecesResolved.pieceId).toBe("of:piece-123");
    expect(entitiesResolved.pieceId).toBe("of:piece-123");
  });

  it("resolves root-level FS projection callables as result callables", async () => {
    const mountpoint = join(tmpDir, "mount");
    const pieceDir = join(mountpoint, "home/pieces/notes-2");
    const filePath = join(pieceDir, "add.handler");
    await Deno.mkdir(pieceDir, { recursive: true });
    await Deno.writeTextFile(filePath, "");
    await Deno.writeTextFile(
      join(pieceDir, "meta.json"),
      JSON.stringify({
        id: "of:piece-123",
        entityId: "of:piece-123",
        name: "Fixture Piece",
      }),
    );
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const resolved = await resolveMountedCallableFile(filePath, {
      stateDir,
      loadManager: () => Promise.resolve(harness.manager),
      loadPiece: () => Promise.resolve(harness.piece),
    });

    expect(resolved.callablePath).toEqual({
      spaceName: "home",
      rootKind: "pieces",
      rootName: "notes-2",
      cellProp: "result",
      cellKey: "add",
      callableKind: "handler",
      rootLevel: true,
    });
    expect(resolved.pieceId).toBe("of:piece-123");
  });

  it("resolves sparse stream handler cells whose value is undefined", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      sparseHandlerCell: true,
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const resolved = await resolveMountedCallableFile(filePath, {
      stateDir,
      loadManager: () => Promise.resolve(harness.manager),
      loadPiece: () => Promise.resolve(harness.piece),
    });

    expect(resolved.callablePath.callableKind).toBe("handler");
  });

  it("resolves callable paths through a symlinked alias of the mountpoint", async () => {
    const realRoot = join(tmpDir, "real");
    const mountpoint = join(realRoot, "mount");
    const aliasRoot = join(tmpDir, "alias");
    await Deno.mkdir(mountpoint, { recursive: true });
    await Deno.symlink(realRoot, aliasRoot);

    await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const filePath = join(
      aliasRoot,
      "mount/home/pieces/notes-2/result/add.handler",
    );
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const resolved = await resolveMountedCallableFile(filePath, {
      stateDir,
      loadManager: () => Promise.resolve(harness.manager),
      loadPiece: () => Promise.resolve(harness.piece),
    });

    expect(resolved.callablePath.rootKind).toBe("pieces");
    expect(resolved.pieceId).toBe("of:piece-123");
  });

  it("reads mounted metadata from the canonical target of symlinked callable paths", async () => {
    const mountpoint = join(tmpDir, "mount");
    const realPath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:real-piece",
    });
    const aliasDir = join(tmpDir, "alias", "result");
    await Deno.mkdir(aliasDir, { recursive: true });
    const aliasPath = join(aliasDir, "add.handler");
    await Deno.symlink(realPath, aliasPath);
    await Deno.writeTextFile(
      join(tmpDir, "alias", "meta.json"),
      JSON.stringify({
        id: "of:fake-piece",
        entityId: "of:fake-piece",
        name: "Fake Piece",
      }),
    );
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:real-piece",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const resolved = await resolveMountedCallableFile(aliasPath, {
      stateDir,
      loadManager: () => Promise.resolve(harness.manager),
      loadPiece: (_manager, pieceId) => {
        expect(pieceId).toBe("of:real-piece");
        return Promise.resolve(harness.piece);
      },
    });

    expect(resolved.pieceId).toBe("of:real-piece");
  });

  it("calls asSchemaFromLinks on the resolved child cell", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    await resolveMountedCallableFile(filePath, {
      stateDir,
      loadManager: () => Promise.resolve(harness.manager),
      loadPiece: () => Promise.resolve(harness.piece),
    });

    expect(harness.tracker.asSchemaFromLinksCalls).toBeGreaterThan(0);
  });

  it("starts the piece before dispatching a mounted handler", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const originalGet = PiecesController.prototype.get;
    const runItArgs: boolean[] = [];
    PiecesController.prototype.get = function (
      pieceId: string,
      runIt?: boolean,
      _schema?: JSONSchema,
    ) {
      runItArgs.push(runIt ?? false);
      expect(pieceId).toBe("of:piece-123");
      return Promise.resolve(harness.piece as never);
    };

    try {
      await executeMountedCallableFile(
        filePath,
        ["--query", "milk"],
        {
          stateDir,
          loadManager: () => Promise.resolve(harness.manager),
        },
      );
    } finally {
      PiecesController.prototype.get = originalGet;
    }

    expect(runItArgs).toEqual([true]);
  });

  it("dispatches handlers through the same piece-property path used by FUSE writes", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const result = await executeMountedCallableFile(
      filePath,
      ["--query", "milk"],
      {
        stateDir,
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
      },
    );

    expect(result.outputText).toBeUndefined();
    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["add"],
        value: { query: "milk" },
      },
    ]);
  });

  it("preserves the Cell.send receiver when dispatching mounted handlers", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      handlerSendRequiresReceiver: true,
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    await executeMountedCallableFile(filePath, ["--query", "milk"], {
      stateDir,
      loadManager: () => Promise.resolve(harness.manager),
      loadPiece: () => Promise.resolve(harness.piece),
    });

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["add"],
        value: { query: "milk" },
      },
    ]);
  });

  it("surfaces mounted handler transaction failures as errors", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      handlerFailureMessage: "Mounted handler failed",
    });

    await writeLiveMountState(stateDir, mountpoint);

    await expect(
      executeMountedCallableFile(
        filePath,
        ["--message", "milk"],
        {
          stateDir,
          loadManager: () => Promise.resolve(harness.manager),
          loadPiece: () => Promise.resolve(harness.piece),
        },
      ),
    ).rejects.toThrow(/Handler "add" failed: Mounted handler failed/);
  });

  it("dispatches tools with extraParams merged into the runtime input and returns JSON output", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          help: { type: "string" },
        },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            help: { type: "string" },
            source: { type: "string" },
            result: { type: "string" },
          },
          required: ["query"],
        },
        resultSchema: {
          type: "object",
          properties: {
            echoed: { type: "string" },
            source: { type: "string" },
          },
        },
      },
      extraParams: {
        source: "bound-source",
        result: "bound-result",
      },
      toolResult: {
        echoed: "tea",
        source: "bound-source",
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const resolved = await resolveMountedCallableFile(filePath, {
      stateDir,
      loadManager: () => Promise.resolve(harness.manager),
      loadPiece: () => Promise.resolve(harness.piece),
    });
    const result = await executeMountedCallableFile(
      filePath,
      ["--query", "tea"],
      {
        stateDir,
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        uuid: () => "tool-result-id",
      },
    );

    expect(
      Object.keys(
        (resolved.commandSpec.inputSchema as {
          properties?: Record<string, unknown>;
        })
          .properties ?? {},
      ),
    ).toEqual(["query", "help"]);
    expect(harness.tracker.toolRunInput).toEqual({
      query: "tea",
      help: "",
      source: "bound-source",
      result: "bound-result",
    });
    expect(JSON.parse(result.outputText!)).toEqual({
      echoed: "tea",
      source: "bound-source",
    });
  });

  it("settles mounted tool results before reading, without polling", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
        resultSchema: {
          type: "object",
          properties: {
            echoed: { type: "string" },
          },
        },
      },
      toolResult: { echoed: "tea" },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const result = await executeMountedCallableFile(
      filePath,
      ["--query", "tea"],
      {
        stateDir,
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        uuid: () => "tool-result-id",
      },
    );

    // Commit, then drain to a fully settled state, then read the result cell
    // once. No poll loop and no deadline: `settled()` awaits the tool's async
    // work to completion.
    expect(harness.tracker.events).toEqual([
      "run",
      "idle",
      "commit",
      "settled",
    ]);
    expect(JSON.parse(result.outputText!)).toEqual({ echoed: "tea" });
  });

  it("uses mounted tool sink output after a successful commit", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
        resultSchema: {
          type: "object",
          properties: {
            echoed: { type: "string" },
          },
        },
      },
      toolSinkValue: { echoed: "from-sink" },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const result = await executeMountedCallableFile(
      filePath,
      ["--query", "tea"],
      {
        stateDir,
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        uuid: () => "tool-result-id",
      },
    );

    // The sink reported the result, so after settling there is no result-cell
    // read at all — the sink value is authoritative.
    expect(harness.tracker.events).toEqual([
      "run",
      "sink",
      "idle",
      "commit",
      "settled",
    ]);
    expect(JSON.parse(result.outputText!)).toEqual({ echoed: "from-sink" });
  });

  it("fails loudly when a mounted tool settles without a result", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        resultSchema: { type: "object" },
      },
      // No toolResult, no sink value, no recorded error: the tool settled
      // without producing anything.
    });

    await writeLiveMountState(stateDir, mountpoint);

    await expect(
      executeMountedCallableFile(filePath, ["--query", "tea"], {
        stateDir,
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        uuid: () => "tool-result-id",
      }),
    ).rejects.toThrow('Tool "search" produced no result.');
  });

  it("surfaces the recorded runtime error when a mounted tool produces no result", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        resultSchema: { type: "object" },
      },
      // The tool run records a runtime error and writes no result.
      toolRunError: "boom from the tool pattern",
    });

    await writeLiveMountState(stateDir, mountpoint);

    await expect(
      executeMountedCallableFile(filePath, ["--query", "tea"], {
        stateDir,
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        uuid: () => "tool-result-id",
      }),
    ).rejects.toThrow('Tool "search" failed: boom from the tool pattern');
  });

  it("pulls mounted tool result cells before serializing output", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          help: { type: "string" },
        },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            help: { type: "string" },
            source: { type: "string" },
          },
          required: ["query", "source"],
        },
        resultSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            help: { type: "string" },
            source: { type: "string" },
            summary: { type: "string" },
          },
        },
      },
      extraParams: {
        source: "bound-source",
      },
      toolResultGetValue: {
        query: "explicit",
        help: "schema-field",
        source: "bound-source",
        summary: "bound-source:explicit:undefined",
      },
      toolResultPullValue: {
        query: "explicit",
        help: "schema-field",
        source: "bound-source",
        summary: "bound-source:explicit:schema-field",
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const result = await executeMountedCallableFile(
      filePath,
      ["--query", "explicit", "--help", "schema-field"],
      {
        stateDir,
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
      },
    );

    expect(harness.tracker.toolRunInput).toEqual({
      query: "explicit",
      help: "schema-field",
      source: "bound-source",
    });
    expect(JSON.parse(result.outputText!)).toEqual({
      query: "explicit",
      help: "schema-field",
      source: "bound-source",
      summary: "bound-source:explicit:schema-field",
    });
  });

  it("allocates tool result cells in the resolved space DID", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      managerSpace: "did:key:resolved-space",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
        resultSchema: {
          type: "object",
          properties: {
            echoed: { type: "string" },
          },
        },
      },
      toolResult: {
        echoed: "tea",
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    await executeMountedCallableFile(
      filePath,
      ["--query", "tea"],
      {
        stateDir,
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        uuid: () => "tool-result-id",
      },
    );

    expect(harness.tracker.toolResultSpace).toBe("did:key:resolved-space");
  });

  it("reads --json input from stdin for mounted handlers", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    await executeMountedCallableFile(
      filePath,
      ["--json"],
      {
        stateDir,
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        readJsonInput: () => Promise.resolve({ query: "milk" }),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["add"],
        value: { query: "milk" },
      },
    ]);
  });

  it("infers piped stdin for mounted primitive handlers when no args are provided", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: { type: "string" },
    });

    await writeLiveMountState(stateDir, mountpoint);

    await executeMountedCallableFile(
      filePath,
      [],
      {
        stateDir,
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => false,
        readTextInput: () => Promise.resolve("# Title\n\nLine 2"),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["add"],
        value: "# Title\n\nLine 2",
      },
    ]);
  });

  it("passes implicit piped JSON through for mounted object handlers without CLI shape enforcement", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    await executeMountedCallableFile(
      filePath,
      [],
      {
        stateDir,
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => false,
        readTextInput: () => Promise.resolve('["not-an-object"]'),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["add"],
        value: ["not-an-object"],
      },
    ]);
  });

  it("passes stdin --json through unchanged for mounted tools", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          help: { type: "string" },
        },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            help: { type: "string" },
            source: { type: "string" },
          },
          required: ["query", "source"],
        },
        resultSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
          },
        },
      },
      extraParams: {
        source: "bound-source",
      },
      toolResult: {
        summary: "bound-source:tea",
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    await executeMountedCallableFile(
      filePath,
      ["--json"],
      {
        stateDir,
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        readJsonInput: () => Promise.resolve({ query: "tea" }),
      },
    );

    expect(harness.tracker.toolRunInput).toEqual({
      query: "tea",
      source: "bound-source",
    });
  });

  it("passes inline --json through unchanged for mounted tools", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          help: { type: "string" },
        },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            help: { type: "string" },
            source: { type: "string" },
          },
          required: ["query", "source"],
        },
        resultSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
          },
        },
      },
      extraParams: {
        source: "bound-source",
      },
      toolResult: {
        summary: "bound-source:tea",
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    await executeMountedCallableFile(
      filePath,
      ["--json", '{"query":"tea"}'],
      {
        stateDir,
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
      },
    );

    expect(harness.tracker.toolRunInput).toEqual({
      query: "tea",
      source: "bound-source",
    });
  });

  it("parses stdin JSON for --json without enforcing the linked schema in the CLI", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/add.handler",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "handler",
      cellProp: "result",
      cellKey: "add",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    await executeMountedCallableFile(
      filePath,
      ["--json"],
      {
        stateDir,
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        readJsonInput: () => Promise.resolve(["not-an-object"]),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["add"],
        value: ["not-an-object"],
      },
    ]);
  });

  it("returns machine-readable schema details for --help --json", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:piece-123",
    });
    const harness = createExecHarness({
      callableKind: "tool",
      cellProp: "result",
      cellKey: "search",
      pieceId: "of:piece-123",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            source: { type: "string" },
          },
          required: ["query"],
        },
        resultSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
          },
        },
      },
      extraParams: {
        source: "bound-source",
      },
    });

    await writeLiveMountState(stateDir, mountpoint);

    const result = await executeMountedCallableFile(
      filePath,
      ["--help", "--json"],
      {
        stateDir,
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
      },
    );

    expect(result.helpText).toBeDefined();
    expect(JSON.parse(result.helpText!)).toEqual({
      callableKind: "tool",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      outputSchema: {
        type: "object",
        properties: {
          summary: { type: "string" },
        },
      },
    });
  });
});

async function writeLiveMountState(
  stateDir: string,
  mountpoint: string,
  apiUrl = "http://localhost:8000",
) {
  await Deno.mkdir(mountpoint, { recursive: true });
  await writeMountState(stateDir, {
    pid: Deno.pid,
    mountpoint,
    apiUrl,
    identity: "/tmp/test-identity.pem",
    startedAt: "2026-03-17T00:00:00.000Z",
  });
}

async function createMountedFile(
  mountpoint: string,
  options: {
    relativePath: string;
    pieceId: string;
    patternRef?: {
      identity: string;
      symbol: string;
      source: {
        ref: string;
        repository?: string;
        entry?: string;
        origin?: string;
      };
    };
  },
): Promise<string> {
  const absPath = join(mountpoint, options.relativePath);
  await Deno.mkdir(dirname(absPath), { recursive: true });
  await Deno.writeTextFile(absPath, "");

  const metaPath = join(dirname(dirname(absPath)), "meta.json");
  await Deno.writeTextFile(
    metaPath,
    JSON.stringify({
      id: options.pieceId,
      entityId: options.pieceId,
      name: "Fixture Piece",
      ...(options.patternRef === undefined
        ? {}
        : { patternRef: options.patternRef }),
    }),
  );

  return absPath;
}

function createExecHarness(options: {
  callableKind: "handler" | "tool";
  cellProp: "input" | "result";
  cellKey: string;
  pieceId: string;
  managerSpace?: string;
  inputSchema: JSONSchema;
  pattern?: {
    argumentSchema: JSONSchema;
    resultSchema?: JSONSchema;
  };
  extraParams?: Record<string, unknown>;
  toolResult?: unknown;
  toolResultGetValue?: unknown;
  toolResultPullValue?: unknown;
  toolSinkValue?: unknown;
  toolRunError?: string;
  handlerFailureMessage?: string;
  handlerSendRequiresReceiver?: boolean;
  sparseHandlerCell?: boolean;
}) {
  const tracker = {
    events: [] as string[],
    asSchemaFromLinksCalls: 0,
    handlerWrites: [] as Array<{
      cellProp: "input" | "result";
      path: (string | number)[] | undefined;
      value: unknown;
    }>,
    toolRunInput: undefined as unknown,
    toolResultSpace: undefined as string | undefined,
  };

  const callableSchema: JSONSchema = options.callableKind === "tool"
    ? {
      type: "object",
      properties: {
        pattern: { type: "object" },
        extraParams: { type: "object" },
      },
    }
    : options.inputSchema;
  const callableValue = options.callableKind === "tool"
    ? {
      pattern: options.pattern,
      extraParams: options.extraParams ?? {},
    }
    : options.sparseHandlerCell
    ? undefined
    : { $stream: true };
  const runtimeErrors: Array<{ message: string }> = [];
  const handlerSend = function (
    this: unknown,
    value: unknown,
    onCommit?: (
      tx: { status: () => { status: string; error?: Error } },
    ) => void,
  ) {
    if (options.handlerSendRequiresReceiver && this !== callableCell) {
      throw new Error("Cell.send receiver lost");
    }
    tracker.handlerWrites.push({
      cellProp: "result",
      path: [options.cellKey],
      value,
    });
    if (options.handlerFailureMessage) {
      runtimeErrors.push({ message: options.handlerFailureMessage });
    }
    onCommit?.({
      status: () =>
        options.handlerFailureMessage
          ? {
            status: "error",
            error: new Error(options.handlerFailureMessage),
          }
          : { status: "done" },
    });
  };
  const callableCell = createMockCell(
    callableValue,
    callableSchema,
    options.callableKind === "handler"
      ? {
        onSchemaFromLinks: () => {
          tracker.asSchemaFromLinksCalls++;
        },
        isStream: () => options.sparseHandlerCell === true,
        send: handlerSend,
      }
      : {
        onSchemaFromLinks: () => {
          tracker.asSchemaFromLinksCalls++;
        },
      },
  );
  const rootCell = createMockCell(
    {
      [options.cellKey]: callableValue,
    },
    {
      type: "object",
      properties: {
        [options.cellKey]: callableSchema,
      },
    },
    {
      childOverrides: { [options.cellKey]: callableCell },
    },
  );

  const state = {
    value: options.toolResult,
    getValue: options.toolResultGetValue,
    pullValue: options.toolResultPullValue,
  };
  const resultCell = {
    get: () => state.getValue ?? state.value,
    pull: () => Promise.resolve(state.pullValue ?? state.value),
    key: (_key: string) => resultCell,
    asSchemaFromLinks: () => resultCell,
  };

  const piece = {
    id: options.pieceId,
    input: {
      getCell: () => Promise.resolve(rootCell),
      set: (value: unknown, path?: (string | number)[]) => {
        tracker.handlerWrites.push({ cellProp: "input", path, value });
        return Promise.resolve();
      },
    },
    result: {
      getCell: () => Promise.resolve(rootCell),
      set: (value: unknown, path?: (string | number)[]) => {
        tracker.handlerWrites.push({ cellProp: "result", path, value });
        return Promise.resolve();
      },
    },
  };

  const manager = {
    getSpace: () => options.managerSpace ?? "home",
    synced: () => {
      tracker.events.push("manager.synced");
      return Promise.resolve();
    },
    runtime: {
      [CF_RUNTIME_ERROR_LOG]: runtimeErrors,
      storageManager: {
        synced: () => {
          tracker.events.push("storage.synced");
          return Promise.resolve();
        },
      },
      edit: () => ({
        commit: () => {
          tracker.events.push("commit");
          return Promise.resolve();
        },
      }),
      getCell: (
        space: string,
        _id: string,
        _schema: JSONSchema | undefined,
        _tx: unknown,
      ) => {
        tracker.toolResultSpace = space;
        return resultCell;
      },
      run: (
        _tx: unknown,
        _pattern: unknown,
        input: unknown,
        _result: unknown,
      ) => {
        tracker.events.push("run");
        tracker.toolRunInput = input;
        if (options.toolRunError !== undefined) {
          runtimeErrors.push({ message: options.toolRunError });
        }
        state.value = options.toolResult;
        state.getValue = options.toolResultGetValue ?? options.toolResult;
        state.pullValue = options.toolResultPullValue ?? options.toolResult;
        return {
          sink: (callback: (value: unknown) => void) => {
            if (options.toolSinkValue !== undefined) {
              tracker.events.push("sink");
              callback(options.toolSinkValue);
            }
            return () => {};
          },
        };
      },
      idle: () => {
        tracker.events.push("idle");
        return Promise.resolve();
      },
      settled: () => {
        tracker.events.push("settled");
        return Promise.resolve();
      },
    },
  };

  return { manager, piece, tracker };
}

function createMockCell(
  value: unknown,
  schema: JSONSchema | undefined,
  options?: {
    childOverrides?: Record<string, ReturnType<typeof createMockCell>>;
    onSchemaFromLinks?: () => void;
    send?: (
      value: unknown,
      onCommit?: (
        tx: { status: () => { status: string; error?: Error } },
      ) => void,
    ) => void;
    isStream?: () => boolean;
  },
) {
  const cell = {
    schema,
    get: () => value,
    getRaw: () => value,
    asSchemaFromLinks: () => {
      options?.onSchemaFromLinks?.();
      return cell;
    },
    send: options?.send,
    isStream: options?.isStream,
    key: (key: string) => {
      if (options?.childOverrides?.[key]) {
        return options.childOverrides[key];
      }
      const nextValue =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)[key]
          : undefined;
      const nextSchema = getChildSchema(schema, key);
      return createMockCell(nextValue, nextSchema);
    },
  };

  return cell;
}

function getChildSchema(
  schema: JSONSchema | undefined,
  key: string,
): JSONSchema | undefined {
  if (
    !schema || typeof schema !== "object" || schema === null ||
    Array.isArray(schema)
  ) {
    return undefined;
  }

  const properties = schema.properties;
  if (
    typeof properties !== "object" || properties === null ||
    Array.isArray(properties)
  ) {
    return undefined;
  }

  return properties[key] as JSONSchema | undefined;
}
