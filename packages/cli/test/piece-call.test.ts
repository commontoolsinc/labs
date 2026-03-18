import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commontools/api";
import { executePieceCallable } from "../lib/piece.ts";

describe("executePieceCallable", () => {
  it("invokes handlers from schema-derived flags", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "recordMessage",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
    });

    const result = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "of:piece-123",
        space: "home",
      },
      "recordMessage",
      ["--message", "milk"],
      {
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
      },
    );

    expect(result.outputText).toBeUndefined();
    expect(result.resolved.callableKind).toBe("handler");
    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["recordMessage"],
        value: { message: "milk" },
      },
    ]);
  });

  it("runs tools from schema-derived flags and returns JSON output", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "tool",
      cellKey: "search",
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
            source: { type: "string" },
          },
        },
      },
      extraParams: {
        source: "bound-source",
      },
      toolResult: {
        summary: "bound-source:tea",
        source: "bound-source",
      },
    });

    const result = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "of:piece-123",
        space: "home",
      },
      "search",
      ["--query", "tea"],
      {
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        uuid: () => "tool-result-id",
      },
    );

    expect(result.resolved.callableKind).toBe("tool");
    expect(harness.tracker.toolRunInput).toEqual({
      query: "tea",
      help: "",
      source: "bound-source",
    });
    expect(JSON.parse(result.outputText!)).toEqual({
      summary: "bound-source:tea",
      source: "bound-source",
    });
  });

  it("renders piece-call help with the piece-call command prefix", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "tool",
      cellKey: "search",
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
      },
    });

    const result = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "of:piece-123",
        space: "home",
      },
      "search",
      ["--help"],
      {
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
      },
    );

    expect(result.helpText).toContain(
      "ct piece call ... search --help",
    );
    expect(result.helpText).toContain(
      "ct piece call ... search -- [run] --query <string>",
    );
    expect(result.helpText).toContain("JSON input:");
    expect(result.helpText).toContain("Pass inline JSON as the next argument");
    expect(result.helpText).toContain("query: string");
    expect(result.helpText).toContain("Flags after `--`:");
    expect(result.helpText).not.toContain(
      "Read the full input object from stdin.",
    );
    expect(result.helpText).not.toContain(
      "ct piece call ... search -- [run] --help",
    );
    expect(result.helpText).not.toContain("ct exec");
  });
});

function createPieceCallableHarness(options: {
  callableKind: "handler" | "tool";
  cellKey: string;
  inputSchema: JSONSchema;
  pattern?: {
    argumentSchema: JSONSchema;
    resultSchema?: JSONSchema;
  };
  extraParams?: Record<string, unknown>;
  toolResult?: unknown;
}) {
  const tracker = {
    handlerWrites: [] as Array<{
      cellProp: "input" | "result";
      path: (string | number)[] | undefined;
      value: unknown;
    }>,
    toolRunInput: undefined as unknown,
  };

  const callableSchema: JSONSchema = options.callableKind === "tool"
    ? {
      type: "object",
      properties: {
        pattern: {
          type: "object",
          properties: {
            argumentSchema: { type: "object" },
            resultSchema: { type: "object" },
          },
        },
        extraParams: { type: "object" },
      },
    }
    : options.inputSchema;
  const callableValue = options.callableKind === "tool"
    ? {
      pattern: options.pattern,
      extraParams: options.extraParams ?? {},
    }
    : { $stream: true };
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
  );

  const state = { value: options.toolResult };
  const resultCell = {
    get: () => state.value,
    key: (_key: string) => resultCell,
    asSchemaFromLinks: () => resultCell,
  };

  const piece = {
    getCell: () => ({
      asSchema: () => ({
        key: (key: string) => ({
          isStream: () =>
            options.callableKind === "handler" && key === options.cellKey,
        }),
      }),
    }),
    input: {
      getCell: () => Promise.resolve(createMockCell({}, { type: "object" })),
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
    getSpace: () => "home",
    synced: async () => {},
    runtime: {
      edit: () => ({
        commit: async () => {},
      }),
      getCell: (
        _space: string,
        _id: string,
        _schema: JSONSchema | undefined,
        _tx: unknown,
      ) => resultCell,
      run: (
        _tx: unknown,
        _pattern: unknown,
        input: unknown,
        _result: unknown,
      ) => {
        tracker.toolRunInput = input;
        state.value = options.toolResult;
        return {
          sink: () => () => {},
        };
      },
      idle: async () => {},
    },
  };

  return { manager, piece, tracker };
}

function createMockCell(
  value: unknown,
  schema: JSONSchema | undefined,
) {
  const cell = {
    schema,
    get: () => value,
    getRaw: () => value,
    asSchemaFromLinks: () => cell,
    key: (key: string) => {
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
