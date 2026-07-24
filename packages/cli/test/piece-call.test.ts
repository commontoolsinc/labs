import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import { CF_RUNTIME_ERROR_LOG } from "../lib/callable.ts";
import {
  executePieceCallable,
  PieceResultProjectionError,
} from "../lib/piece.ts";
import {
  exitWithDataError,
  isPieceGetDataError,
  pieceCallRawArgs,
  pieceGetDataErrorReport,
  pieceLinkDataErrorReport,
} from "../commands/piece.ts";
import { LinkValidationError } from "../lib/piece.ts";

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
    // The result cell's durable address rides along — the handle a caller can
    // revisit instead of re-running the tool (verb contract Part 2).
    expect(result.resultRef).toEqual({
      id: "of:tool-result-cell",
      space: "did:key:test-home",
      scope: "space",
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

    expect(harness.tracker.toolResultScope).toBe("user");
    // The returned handle preserves the scope — dropping it would silently
    // retarget a user-scoped result to the space-scoped instance.
    expect(result.resultRef?.scope).toBe("user");
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
    getAsNormalizedFullLink: () => ({
      id: "of:tool-result-cell",
      space: "did:key:test-home",
      scope: options.callableScope ?? "space",
    }),
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
      idle: async () => {},
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

describe("piece call stdin payloads", () => {
  it('maps a bare "-" payload onto the --json-file stdin path', () => {
    expect(pieceCallRawArgs(["-"], [])).toEqual(["--json-file", "-"]);
  });

  it("forwards explicit two-token stdin sentinels instead of rejecting them", () => {
    // `cf piece call h --json-file -` (and the --value-file / --json variants)
    // should read stdin, matching `cf exec` and the bare "-" form, rather than
    // hitting the multi-argument rejection.
    expect(pieceCallRawArgs(["--json-file", "-"], [])).toEqual([
      "--json-file",
      "-",
    ]);
    expect(pieceCallRawArgs(["--value-file", "-"], [])).toEqual([
      "--value-file",
      "-",
    ]);
    expect(pieceCallRawArgs(["--json", "-"], [])).toEqual(["--json", "-"]);
    // A file path (not "-") still requires "--"; it is not a stdin sentinel.
    expect(() => pieceCallRawArgs(["--json-file", "/p.json"], [])).toThrow(
      /single inline JSON argument or "--"/,
    );
  });

  it("rejects a payload token combined with post-`--` flags instead of dropping it", () => {
    // `cf piece call h - -- --query milk` → tail=["-"], literalArgs=["--query",
    // "milk"]. The "-" used to be silently ignored (post-`--` flags win); now
    // the conflict is loud.
    expect(() => pieceCallRawArgs(["-"], ["--query", "milk"])).toThrow(
      /payload argument .* or .* schema-derived flags after/,
    );
    expect(() => pieceCallRawArgs(['{"x":1}'], ["--query", "milk"])).toThrow(
      /not both/,
    );
    // The legit "flags after -- only" shape (tail empty) still passes through.
    expect(pieceCallRawArgs([], ["--query", "milk"])).toEqual([
      "--query",
      "milk",
    ]);
  });

  it('reads the payload from stdin for a bare "-"', async () => {
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
      ["--json-file", "-"],
      {
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => false,
        readTextInput: () => Promise.resolve('{"message":"from stdin"}'),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["recordMessage"],
        value: { message: "from stdin" },
      },
    ]);
  });

  it('treats "--json -" as the stdin sentinel', async () => {
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
      ["--json", "-"],
      {
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => false,
        readTextInput: () => Promise.resolve('{"message":"json stdin"}'),
      },
    );

    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["recordMessage"],
        value: { message: "json stdin" },
      },
    ]);
  });

  it('fails loudly when "-" gets empty stdin', async () => {
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

    await expect(
      executePieceCallable(
        {
          apiUrl: "http://localhost:8000",
          identity: "/tmp/test-identity.pem",
          piece: "fid1:piece-123",
          space: "home",
        },
        "recordMessage",
        ["--json-file", "-"],
        {
          loadManager: () => Promise.resolve(harness.manager),
          loadPiece: () => Promise.resolve(harness.piece),
          isStdinTerminal: () => false,
          readTextInput: () => Promise.resolve(""),
        },
      ),
    ).rejects.toThrow(/Expected JSON from stdin/);
  });
});

describe("piece get data errors", () => {
  it("classifies unresolved-path failures as data errors, not usage errors", () => {
    expect(
      isPieceGetDataError(
        new Error('Cannot access path "bogus" - property "bogus" not found'),
      ),
    ).toBe(true);
    expect(isPieceGetDataError(new Error("network unreachable"))).toBe(false);
    expect(isPieceGetDataError("Cannot access path")).toBe(false);
  });

  it("reports a result-mode data error with an --input hint", () => {
    const report = pieceGetDataErrorReport(
      new Error('Cannot access path "x" - property "x" not found'),
      { input: false, piece: "fid1:piece-123" },
    );
    expect(report?.message).toMatch(/Cannot access path "x"/);
    expect(report?.hint).toMatch(/retry with --input/);
    expect(report?.hint).toMatch(/fid1:piece-123/);
  });

  it("omits the hint in input mode (nothing left to suggest)", () => {
    const report = pieceGetDataErrorReport(
      new Error('Cannot access path "x" - property "x" not found'),
      { input: true, piece: "fid1:piece-123" },
    );
    expect(report?.message).toMatch(/Cannot access path "x"/);
    expect(report?.hint).toBeUndefined();
  });

  it("returns null for a non-data error (caller rethrows)", () => {
    expect(
      pieceGetDataErrorReport(new Error("network unreachable"), {
        input: false,
        piece: "fid1:piece-123",
      }),
    ).toBeNull();
  });

  it("treats a result-projection failure as a data error, keeping its own --step hint", () => {
    const projectionError = new PieceResultProjectionError(
      ["totalSpent"],
      false,
    );
    expect(isPieceGetDataError(projectionError)).toBe(true);
    const report = pieceGetDataErrorReport(projectionError, {
      input: false,
      piece: "fid1:piece-123",
    });
    // The message carries its own --step guidance; we must not bury it under
    // the generic --input tip (a different remedy).
    expect(report?.message).toMatch(/schema could not resolve/);
    expect(report?.message).toMatch(/--step/);
    expect(report?.hint).toBeUndefined();
  });
});

describe("piece link data errors", () => {
  it("reports a validation failure with an inspect hint for both pieces", () => {
    const report = pieceLinkDataErrorReport(
      new LinkValidationError(
        'Target path "config/email" does not exist on piece fid1:target-1\n\nUse --allow-non-existing to link anyway.',
      ),
      { sourcePieceId: "fid1:source-1", targetPieceId: "fid1:target-1" },
    );
    // The runtime's message survives verbatim — it carries its own
    // --allow-non-existing next step — and the hint adds the inspect pointer.
    expect(report?.message).toMatch(/does not exist on piece fid1:target-1/);
    expect(report?.message).toMatch(/--allow-non-existing/);
    expect(report?.hint).toMatch(/piece inspect/);
    expect(report?.hint).toMatch(/fid1:source-1/);
    expect(report?.hint).toMatch(/fid1:target-1/);
  });

  it("returns null for a non-validation error (caller rethrows)", () => {
    expect(
      pieceLinkDataErrorReport(new Error("network unreachable"), {
        sourcePieceId: "fid1:source-1",
        targetPieceId: "fid1:target-1",
      }),
    ).toBeNull();
  });
});

describe("exitWithDataError", () => {
  const exitSentinel = (exited: number[]) => (code: number): never => {
    exited.push(code);
    throw new Error("exit-sentinel");
  };

  it("prints message then hint to stderr sinks and exits 1", () => {
    const printed: string[] = [];
    const exited: number[] = [];
    expect(() =>
      exitWithDataError({ message: "boom", hint: "TIP: look closer" }, {
        printError: (m) => printed.push(`error:${m}`),
        printHint: (m) => printed.push(`hint:${m}`),
        exit: exitSentinel(exited),
      })
    ).toThrow("exit-sentinel");
    expect(printed).toEqual(["error:boom", "hint:TIP: look closer"]);
    expect(exited).toEqual([1]);
  });

  it("omits the hint line when the report has none", () => {
    const printed: string[] = [];
    const exited: number[] = [];
    expect(() =>
      exitWithDataError({ message: "boom" }, {
        printError: (m) => printed.push(`error:${m}`),
        printHint: (m) => printed.push(`hint:${m}`),
        exit: exitSentinel(exited),
      })
    ).toThrow("exit-sentinel");
    expect(printed).toEqual(["error:boom"]);
    expect(exited).toEqual([1]);
  });
});
