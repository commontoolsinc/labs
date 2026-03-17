import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commontools/api";
import {
  type ExecCommandSpec,
  parseExecArgs,
  renderExecHelp,
} from "../lib/exec-schema.ts";

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
  it("defaults handlers to invoke and tools to run", () => {
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
    expect(result.input).toEqual({});
  });

  it("treats post-verb --help as a string schema field when help exists", () => {
    const result = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          help: { type: "string" },
          query: { type: "string" },
        },
      }),
      ["run", "--help", "details", "--query", "milk"],
    );

    expect(result.showHelp).toBe(false);
    expect(result.input).toEqual({
      help: "details",
      query: "milk",
    });
  });

  it("treats post-verb --help as a boolean schema field when help is boolean", () => {
    const result = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          help: { type: "boolean" },
        },
      }),
      ["run", "--help"],
    );

    expect(result.showHelp).toBe(false);
    expect(result.input).toEqual({ help: true });
  });

  it("falls back to command help after the verb when help is not a schema field", () => {
    const result = parseExecArgs(
      makeSpec("tool", {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      }),
      ["run", "--help"],
    );

    expect(result.showHelp).toBe(true);
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

  it("supports non-object schemas through --value and object schemas through --json", () => {
    const primitive = parseExecArgs(
      makeSpec("handler", { type: "number" }),
      ["invoke", "--value", "42"],
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
      ["run", "--json", '{"query":"oat milk","filters":{"fresh":true}}'],
    );

    expect(primitive.input).toBe(42);
    expect(json.input).toEqual({
      query: "oat milk",
      filters: { fresh: true },
    });
  });

  it("rejects mixed --json and generated flags", () => {
    expect(() =>
      parseExecArgs(
        makeSpec("tool", {
          type: "object",
          properties: { query: { type: "string" } },
        }),
        ["run", "--json", '{"query":"tea"}', "--query", "coffee"],
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

    expect(() => parseExecArgs(spec, ["run", "--mode", "fast"])).toThrow(
      /Missing required flag --query/i,
    );
    expect(() =>
      parseExecArgs(spec, ["run", "--query", "tea", "--mode", "invalid"])
    ).toThrow(/Invalid value for --mode/i);
    expect(() =>
      parseExecArgs(spec, ["run", "--query", "tea", "--unknown", "value"])
    ).toThrow(/Unknown flag --unknown/i);
  });
});

describe("renderExecHelp", () => {
  it("renders callable kind, verb, input schema, and tool output summary", () => {
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

    expect(help).toContain("tool");
    expect(help).toContain("run");
    expect(help).toContain("/tmp/search.tool");
    expect(help).toContain("query");
    expect(help).toContain("results");
  });
});
