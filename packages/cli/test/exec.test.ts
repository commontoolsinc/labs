import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, join } from "@std/path";
import type { JSONSchema } from "@commontools/api";
import { PiecesController } from "@commontools/piece/ops";
import {
  type ExecCommandSpec,
  parseExecArgs,
  renderExecHelp,
  renderExecHelpJson,
  renderPieceCallHelp,
} from "../lib/exec-schema.ts";
import {
  executeMountedCallableFile,
  resolveMountedCallableFile,
} from "../lib/exec.ts";
import { writeMountState } from "../lib/fuse.ts";
import { ct } from "./utils.ts";

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
          type: "object",
          properties: {},
        }),
        [],
      )
    ).toThrow(
      /Refusing to invoke handler with no inputs; use invoke to call it without inputs/i,
    );
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
    expect(help).toContain("ct exec /tmp/search.tool [run] --query <string>");
    expect(help).toContain("ct exec /tmp/search.tool [run] --json");
    expect(help).toContain("ct exec /tmp/search.tool [run] --help --json");
    expect(help).toContain("--query <string>");
    expect(help).toContain('Optional input field named "help".');
    expect(help).toContain("Read the full input object from stdin.");
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
    expect(help).not.toContain("ct exec ./legacyWrite.handler");
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
      "ct exec /tmp/number.handler [invoke] --value <number>",
    );
    expect(help).toContain("ct exec /tmp/number.handler [invoke] --json");
    expect(help).toContain("--value <number>");
    expect(help).toContain("Read the full input value as JSON from stdin.");
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
      "ct piece call ... search",
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

    expect(help).toContain("ct piece call ... search --help");
    expect(help).toContain("ct piece call ... search --help --json");
    expect(help).toContain("ct piece call ... search <json>");
    expect(help).toContain(
      "ct piece call ... search -- [run] --query <string>",
    );
    expect(help).toContain("JSON input:");
    expect(help).toContain("Pass inline JSON as the next argument");
    expect(help).toContain("query: string");
    expect(help).toContain("help?: string");
    expect(help).toContain("Flags after `--`:");
    expect(help).not.toContain("Read the full input object from stdin.");
    expect(help).not.toContain("ct piece call ... search -- [run] --help");
  });
});

describe("exec command user-facing errors", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await Deno.makeTempDir({ prefix: "ct-exec-cli-test-" });
  });

  afterEach(async () => {
    await Deno.remove(tmpDir, { recursive: true });
  });

  it("prints readable errors without a raw stack trace", async () => {
    const missingPath = join(tmpDir, "missing.handler");
    const { code, stdout, stderr } = await ct(`exec ${missingPath}`);

    expect(code).toBe(1);
    expect(stdout).toEqual([]);

    const relevantStderr = stderr.filter((line) =>
      !line.includes("deno run ") &&
      !line.includes("experimentalDecorators compiler option")
    );

    expect(relevantStderr).toEqual([
      `Path is not within a mounted ct fuse filesystem: ${missingPath}`,
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
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
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
  managerSpace?: string;
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
    synced: async () => {},
    runtime: {
      edit: () => ({
        commit: async () => {},
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
