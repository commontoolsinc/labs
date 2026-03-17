import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, join } from "@std/path";
import type { JSONSchema } from "@commontools/api";
import {
  type ExecCommandSpec,
  parseExecArgs,
  renderExecHelp,
} from "../lib/exec-schema.ts";
import {
  executeMountedCallableFile,
  resolveMountedCallableFile,
} from "../lib/exec.ts";
import { writeMountState } from "../lib/fuse.ts";

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

describe("mounted callable resolution and execution", () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(async () => {
    tmpDir = await Deno.makeTempDir({ prefix: "ct-exec-test-" });
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
    ).rejects.toThrow(/not within a mounted ct fuse filesystem/i);
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
        patternName: "fixture",
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

    await expect(
      resolveMountedCallableFile(filePath, {
        stateDir,
        loadManager: async () => harness.manager,
        loadPiece: async () => harness.piece,
      }),
    ).rejects.toThrow(/mounted callable file not found/i);
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
      loadManager: async () => harness.manager,
      loadPiece: async () => harness.piece,
    });

    expect(resolved.mount.entry.mountpoint).toBe(nestedMount);
    expect(resolved.mount.entry.apiUrl).toBe("http://localhost:9000");
  });

  it("uses sibling meta.json to recover the canonical piece id for de-duped names", async () => {
    const mountpoint = join(tmpDir, "mount");
    const filePath = await createMountedFile(mountpoint, {
      relativePath: "home/pieces/notes-2/result/search.tool",
      pieceId: "of:canonical-piece",
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
      loadManager: async () => harness.manager,
      loadPiece: async () => harness.piece,
    });

    expect(resolved.pieceId).toBe("of:canonical-piece");
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
      loadManager: async () => harness.manager,
      loadPiece: async () => harness.piece,
    });
    const entitiesResolved = await resolveMountedCallableFile(entitiesPath, {
      stateDir,
      loadManager: async () => harness.manager,
      loadPiece: async () => harness.piece,
    });

    expect(piecesResolved.callablePath.rootKind).toBe("pieces");
    expect(entitiesResolved.callablePath.rootKind).toBe("entities");
    expect(piecesResolved.pieceId).toBe("of:piece-123");
    expect(entitiesResolved.pieceId).toBe("of:piece-123");
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
      loadManager: async () => harness.manager,
      loadPiece: async () => harness.piece,
    });

    expect(harness.tracker.asSchemaFromLinksCalls).toBeGreaterThan(0);
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
      ["invoke", "--query", "milk"],
      {
        stateDir,
        loadManager: async () => harness.manager,
        loadPiece: async () => harness.piece,
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
        },
        required: ["query"],
      },
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
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
      loadManager: async () => harness.manager,
      loadPiece: async () => harness.piece,
    });
    const result = await executeMountedCallableFile(
      filePath,
      ["run", "--query", "tea"],
      {
        stateDir,
        loadManager: async () => harness.manager,
        loadPiece: async () => harness.piece,
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
    ).toEqual(["query"]);
    expect(harness.tracker.toolRunInput).toEqual({
      query: "tea",
      source: "bound-source",
      result: "bound-result",
    });
    expect(JSON.parse(result.outputText!)).toEqual({
      echoed: "tea",
      source: "bound-source",
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
  options: { relativePath: string; pieceId: string },
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
      patternName: "fixture",
    }),
  );

  return absPath;
}

function createExecHarness(options: {
  callableKind: "handler" | "tool";
  cellProp: "input" | "result";
  cellKey: string;
  pieceId: string;
  inputSchema: JSONSchema;
  pattern?: {
    argumentSchema: JSONSchema;
    resultSchema?: JSONSchema;
  };
  extraParams?: Record<string, unknown>;
  toolResult?: unknown;
}) {
  const tracker = {
    asSchemaFromLinksCalls: 0,
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
    : {};
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
    () => {
      tracker.asSchemaFromLinksCalls++;
    },
  );

  const state = { value: options.toolResult };
  const resultCell = {
    get: () => state.value,
    key: (_key: string) => resultCell,
    asSchemaFromLinks: () => resultCell,
  };

  const piece = {
    id: options.pieceId,
    input: {
      getCell: async () => rootCell,
      set: async (value: unknown, path?: (string | number)[]) => {
        tracker.handlerWrites.push({ cellProp: "input", path, value });
      },
    },
    result: {
      getCell: async () => rootCell,
      set: async (value: unknown, path?: (string | number)[]) => {
        tracker.handlerWrites.push({ cellProp: "result", path, value });
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
  onSchemaFromLinks?: () => void,
) {
  const cell = {
    schema,
    get: () => value,
    getRaw: () => value,
    asSchemaFromLinks: () => {
      onSchemaFromLinks?.();
      return cell;
    },
    key: (key: string) => {
      const nextValue =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)[key]
          : undefined;
      const nextSchema = getChildSchema(schema, key);
      return createMockCell(nextValue, nextSchema, onSchemaFromLinks);
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
