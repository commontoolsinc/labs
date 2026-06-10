import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import { CF_RUNTIME_ERROR_LOG } from "../lib/callable.ts";
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
        piece: "fid1:piece-123",
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

  it("drains idle+synced BEFORE dispatching a handler event", async () => {
    // A handler reads its asCell inputs (e.g. a SqliteDb handle) synchronously
    // from the local replica, so piece-load watch syncs must be drained before
    // the event is dispatched — not only after (the post-send awaits cover the
    // handler's writes, not its inputs).
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

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "recordMessage",
      ["--message", "milk"],
      {
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
      },
    );

    const events = harness.tracker.events;
    const sendIndex = events.indexOf("send");
    expect(sendIndex).toBeGreaterThan(-1);
    const beforeSend = events.slice(0, sendIndex);
    expect(beforeSend).toContain("idle");
    expect(beforeSend).toContain("synced");
  });

  it("runs tools from schema-derived flags and returns JSON output", async () => {
    const toolPattern: {
      nodes: Array<{ module: string }>;
      argumentSchema: JSONSchema;
      resultSchema: JSONSchema;
    } = {
      nodes: [{ module: "sentinel-node" }],
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
    };
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
      pattern: toolPattern,
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
        piece: "fid1:piece-123",
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
    expect(harness.tracker.toolRunPattern).toBe(toolPattern);
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

  it("passes the configured piece scope when resolving callables", async () => {
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
    let resolvedScope: string | undefined;

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        pieceScope: "session",
        space: "home",
      },
      "recordMessage",
      ["--message", "milk"],
      {
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: (_manager, _pieceId, scope) => {
          resolvedScope = scope;
          return Promise.resolve(harness.piece);
        },
      },
    );

    expect(resolvedScope).toBe("session");
  });

  it("creates pattern tool result cells with the callable scope", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "tool",
      cellKey: "search",
      callableScope: "user",
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
        resultSchema: { type: "object" },
      },
      toolResult: { ok: true },
    });

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
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

    expect(harness.tracker.toolResultScope).toBe("user");
  });

  it("reads primitive handler input from --value-file", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "editContent",
      inputSchema: { type: "string" },
    });

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "editContent",
      ["--value-file", "/tmp/content.md"],
      {
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        readTextFile: () => Promise.resolve("# Title\n\nUse `cat` here"),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["editContent"],
        value: "# Title\n\nUse `cat` here",
      },
    ]);
  });

  it("reads object handler input from --json-file", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "editContent",
      inputSchema: {
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
      },
    });

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "editContent",
      ["--json-file", "/tmp/input.json"],
      {
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        readTextFile: () =>
          Promise.resolve(
            '{"detail":{"value":"Use `cat` to read files"}}',
          ),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["editContent"],
        value: {
          detail: { value: "Use `cat` to read files" },
        },
      },
    ]);
  });

  it("passes --json-file payloads through for object handlers without CLI shape enforcement", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "editContent",
      inputSchema: {
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
      },
    });

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "editContent",
      ["--json-file", "/tmp/input.json"],
      {
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        readTextFile: () => Promise.resolve('["not-an-object"]'),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["editContent"],
        value: ["not-an-object"],
      },
    ]);
  });

  it("infers piped stdin for primitive handlers when no args are provided", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "editContent",
      inputSchema: { type: "string" },
    });

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "editContent",
      [],
      {
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => false,
        readTextInput: () => Promise.resolve("# Title\n\nLine 2"),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["editContent"],
        value: "# Title\n\nLine 2",
      },
    ]);
  });

  it("infers piped stdin for object handlers when no args are provided", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "editContent",
      inputSchema: {
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
      },
    });

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "editContent",
      [],
      {
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => false,
        readTextInput: () =>
          Promise.resolve('{"detail":{"value":"Use `cat` to read files"}}'),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["editContent"],
        value: {
          detail: { value: "Use `cat` to read files" },
        },
      },
    ]);
  });

  it("passes implicit piped JSON through for object handlers without CLI shape enforcement", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "editContent",
      inputSchema: {
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
      },
    });

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "editContent",
      [],
      {
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => false,
        readTextInput: () => Promise.resolve('["not-an-object"]'),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["editContent"],
        value: ["not-an-object"],
      },
    ]);
  });

  it("passes inline --json through for object handlers without CLI shape enforcement", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "editContent",
      inputSchema: {
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
      },
    });

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "editContent",
      ["--json", '["not-an-object"]'],
      {
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["editContent"],
        value: ["not-an-object"],
      },
    ]);
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
        piece: "fid1:piece-123",
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
      "cf piece call ... search --help",
    );
    expect(result.helpText).toContain(
      "cf piece call ... search -- [run] --query <string>",
    );
    expect(result.helpText).toContain("JSON input:");
    expect(result.helpText).toContain("Pass inline JSON as the next argument");
    expect(result.helpText).toContain("query: string");
    expect(result.helpText).toContain("Flags after `--`:");
    expect(result.helpText).not.toContain(
      "Read the full input object from stdin.",
    );
    expect(result.helpText).not.toContain(
      "cf piece call ... search -- [run] --help",
    );
    expect(result.helpText).not.toContain("cf exec");
  });

  it("surfaces handler transaction failures as errors", async () => {
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
      handlerFailureMessage: "Bad message payload",
    });

    await expect(
      executePieceCallable(
        {
          apiUrl: "http://localhost:8000",
          identity: "/tmp/test-identity.pem",
          piece: "fid1:piece-123",
          space: "home",
        },
        "recordMessage",
        ["--message", "milk"],
        {
          loadManager: () => Promise.resolve(harness.manager),
          loadPiece: () => Promise.resolve(harness.piece),
        },
      ),
    ).rejects.toThrow(/Handler "recordMessage" failed: Bad message payload/);
  });
});

function createPieceCallableHarness(options: {
  callableKind: "handler" | "tool";
  cellKey: string;
  inputSchema: JSONSchema;
  pattern?: {
    argumentSchema: JSONSchema;
    resultSchema?: JSONSchema;
  } & Record<string, unknown>;
  extraParams?: Record<string, unknown>;
  toolResult?: unknown;
  handlerFailureMessage?: string;
  callableScope?: "space" | "user" | "session";
}) {
  const tracker = {
    handlerWrites: [] as Array<{
      cellProp: "input" | "result";
      path: (string | number)[] | undefined;
      value: unknown;
    }>,
    toolRunPattern: undefined as unknown,
    toolRunInput: undefined as unknown,
    toolResultScope: undefined as string | undefined,
    // Ordered trace of idle/synced/send calls, for dispatch-ordering tests.
    events: [] as string[],
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
  const runtimeErrors: Array<{ message: string }> = [];
  const callableCell = createMockCell(
    callableValue,
    callableSchema,
    {
      scope: options.callableScope,
      ...(options.callableKind === "handler"
        ? {
          send: (
            value: unknown,
            onCommit?: (
              tx: { status: () => { status: string; error?: Error } },
            ) => void,
          ) => {
            tracker.events.push("send");
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
          },
        }
        : {}),
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
    { childOverrides: { [options.cellKey]: callableCell } },
  );

  const state = { value: options.toolResult };
  const resultCell = {
    schema: options.pattern?.resultSchema,
    get: () => state.value,
    pull: () => Promise.resolve(state.value),
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
    synced: () => {
      tracker.events.push("synced");
      return Promise.resolve();
    },
    runtime: {
      [CF_RUNTIME_ERROR_LOG]: runtimeErrors,
      storageManager: {
        synced: async () => {},
      },
      edit: () => ({
        commit: async () => {},
      }),
      getCell: (
        _space: string,
        _id: string,
        _schema: JSONSchema | undefined,
        _tx: unknown,
        scope?: string,
      ) => {
        tracker.toolResultScope = scope;
        return resultCell;
      },
      run: (
        _tx: unknown,
        pattern: unknown,
        input: unknown,
        _result: unknown,
      ) => {
        tracker.toolRunPattern = pattern;
        tracker.toolRunInput = input;
        state.value = options.toolResult;
        return {
          sink: () => () => {},
        };
      },
      idle: () => {
        tracker.events.push("idle");
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
    send?: (
      value: unknown,
      onCommit?: (
        tx: { status: () => { status: string; error?: Error } },
      ) => void,
    ) => void;
    scope?: "space" | "user" | "session";
  },
) {
  const cell = {
    schema,
    get: () => value,
    getRaw: () => value,
    asSchemaFromLinks: () => cell,
    getAsNormalizedFullLink: () => ({ scope: options?.scope }),
    send: options?.send,
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
