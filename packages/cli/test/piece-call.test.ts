import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import {
  CF_RUNTIME_ERROR_LOG,
  normalizeAbsentVerbPayload,
  verbInputSchemaError,
  VerbInputValidationError,
} from "../lib/callable.ts";
import {
  executePieceCallable,
  PieceResultProjectionError,
} from "../lib/piece.ts";
import {
  exitWithDataError,
  invocationJson,
  invocationPhaseReporter,
  isPieceGetDataError,
  pieceCallInvocation,
  pieceCallRawArgs,
  pieceGetDataErrorReport,
  pieceLinkDataErrorReport,
  reportVerbInputErrorOrRethrow,
  resolveInvocationId,
  verbInputErrorReport,
} from "../commands/piece.ts";
import { LinkValidationError } from "../lib/piece.ts";
import { PieceGetTransformError } from "../lib/piece-get-transform.ts";

describe("executePieceCallable", () => {
  it("preserves plain-text mode while resolving a callable", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "refresh",
      inputSchema: {
        type: "object",
        properties: {},
      },
    });
    let managerConfig: unknown;

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "refresh",
      [],
      {
        loadManager: (config) => {
          managerConfig = config;
          return Promise.resolve(harness.manager);
        },
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => true,
      },
    );

    expect(managerConfig).toEqual({
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      piece: "fid1:piece-123",
      space: "home",
    });
  });

  it("preserves JSON output mode while resolving a callable", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "refresh",
      inputSchema: {
        type: "object",
        properties: {},
      },
    });
    let managerConfig: unknown;

    await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        jsonOutput: true,
        piece: "fid1:piece-123",
        space: "home",
      },
      "refresh",
      [],
      {
        loadManager: (config) => {
          managerConfig = config;
          return Promise.resolve(harness.manager);
        },
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => true,
      },
    );

    expect(managerConfig).toEqual({
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      jsonOutput: true,
      piece: "fid1:piece-123",
      space: "home",
    });
  });

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

  it("rejects a piped payload that fails the verb's schema before dispatch", async () => {
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
        [],
        {
          loadManager: () => Promise.resolve(harness.manager),
          loadPiece: () => Promise.resolve(harness.piece),
          isStdinTerminal: () => false,
          readTextInput: () => Promise.resolve('{"mesage":"milk"}'),
          invocationId: "inv-typo-retry",
        },
      ),
    ).rejects.toThrow(/Invalid input for "recordMessage"/);

    // Nothing reached the stream, so the invocation id was never spent — the
    // corrected retry can still use it. Without this gate the typo'd payload
    // reads back as an absent `$event`, the verb runs with no event, and its
    // receipt burns the id while the call reports settled.
    expect(harness.tracker.handlerWrites).toEqual([]);
    expect(harness.tracker.sendOptions).toEqual([]);
  });

  // Characterized first (pre-D5, observed passing on unmodified code): this
  // exact call dispatched — the handler ran with `$event === undefined` and
  // its receipt spent the invocation id. The schema below is the deployed
  // shape absence reaches dispatch through: a top-level local $ref with the
  // stream marker, which the arg parser cannot derive flags from, so a bare
  // call parses to `input === undefined`.
  it("refuses an absent payload against a verb that provably cannot run without one", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "recordMessage",
      inputSchema: {
        $ref: "#/$defs/RecordMessageEvent",
        asCell: ["stream"],
        $defs: {
          RecordMessageEvent: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
            required: ["message"],
          },
        },
      } as JSONSchema,
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
        [],
        {
          loadManager: () => Promise.resolve(harness.manager),
          loadPiece: () => Promise.resolve(harness.piece),
          isStdinTerminal: () => true,
          invocationId: "inv-absent-retry",
        },
      ),
    ).rejects.toThrow(
      /Invalid input for "recordMessage": no payload was supplied.*message.*send a payload/,
    );

    // Nothing reached the stream, so the invocation id was never spent — the
    // retry that actually sends a payload can still use it.
    expect(harness.tracker.handlerWrites).toEqual([]);
    expect(harness.tracker.sendOptions).toEqual([]);
  });

  it("normalizes an absent payload to {} so an all-defaulted verb receives its defaults", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "refreshFeed",
      inputSchema: {
        $ref: "#/$defs/RefreshEvent",
        asCell: ["stream"],
        $defs: {
          RefreshEvent: {
            type: "object",
            properties: {
              mode: { type: "string", default: "fast" },
              limit: { type: "number", default: 10 },
            },
            required: ["mode", "limit"],
          },
        },
      } as JSONSchema,
      receiptValue: {},
    });

    const result = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "refreshFeed",
      [],
      {
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => true,
        invocationId: "inv-defaulted",
      },
    );

    // `{}` goes out instead of nothing: the runtime materializes defaults for
    // a PRESENT object payload only, so this is the difference between the
    // handler seeing `{ mode: "fast", limit: 10 }` and seeing `undefined`.
    expect(harness.tracker.handlerWrites).toEqual([
      {
        cellProp: "result",
        path: ["refreshFeed"],
        value: {},
      },
    ]);
    expect(result.invocation).toEqual({
      id: "inv-defaulted",
      status: "settled",
    });
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

  it("refuses a --json-file payload that cannot satisfy an object handler", async () => {
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

    // The arg parser still passes JSON through verbatim — it neither reshapes
    // nor rejects. The refusal happens at dispatch, where the payload is
    // measured against the verb's own schema.
    await expect(
      executePieceCallable(
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
      ),
    ).rejects.toThrow(/Invalid input for "editContent"/);

    expect(harness.tracker.handlerWrites).toEqual([]);
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

  it("refuses implicit piped JSON that cannot satisfy an object handler", async () => {
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

    await expect(
      executePieceCallable(
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
      ),
    ).rejects.toThrow(/Invalid input for "editContent"/);

    expect(harness.tracker.handlerWrites).toEqual([]);
  });

  it("refuses inline --json that cannot satisfy an object handler", async () => {
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

    await expect(
      executePieceCallable(
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
      ),
    ).rejects.toThrow(/Invalid input for "editContent"/);

    expect(harness.tracker.handlerWrites).toEqual([]);
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
    expect(result.helpText).toContain(
      "Pass inline JSON as one positional argument or after `--json`",
    );
    expect(result.helpText).toContain(
      "cf piece call ... search --json [<json>]",
    );
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

  it("threads the invocation id to send and settles with receipt readback, without awaiting graph quiescence", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "addComment",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
      receiptValue: { commentId: "c-1" },
    });
    const phases: string[] = [];

    const result = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "addComment",
      ["--message", "milk"],
      {
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        invocationId: "inv-123",
        onPhase: (phase) => phases.push(phase),
      },
    );

    expect(harness.tracker.sendOptions).toEqual([{ eventId: "inv-123" }]);
    expect(result.invocation).toEqual({
      id: "inv-123",
      status: "settled",
      result: { commentId: "c-1" },
    });
    expect(phases).toEqual(["dispatched", "committed", "readback"]);
    expect(harness.tracker.receiptLinkRequested?.id).toBe("of:receipt-1");
    // Transaction-local acknowledgment: the settled result must come straight
    // off this handling's commit — never from draining the whole graph.
    expect(harness.tracker.idleCalls).toBe(0);
    expect(harness.tracker.syncedCalls).toBe(0);
  });

  it("reclassifies a receipt-exists collision as the original settled outcome", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "addComment",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
      receiptExists: true,
      receiptValue: { commentId: "c-original" },
    });

    const result = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "addComment",
      ["--message", "milk"],
      {
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        invocationId: "inv-dup",
      },
    );

    expect(result.invocation).toEqual({
      id: "inv-dup",
      status: "settled",
      deduplicated: true,
      result: { commentId: "c-original" },
    });
  });

  it("settles a value-less verb with no result key (existence-only receipt)", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "refresh",
      inputSchema: { type: "object", properties: {} },
      receiptValue: {},
    });

    const result = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "refresh",
      [],
      {
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => true,
        invocationId: "inv-empty",
      },
    );

    expect(result.invocation).toEqual({ id: "inv-empty", status: "settled" });
  });

  it("sends without options and returns no invocation when no id is supplied", async () => {
    const harness = createPieceCallableHarness({
      callableKind: "handler",
      cellKey: "refresh",
      inputSchema: { type: "object", properties: {} },
      receiptValue: { ignored: true },
    });

    const result = await executePieceCallable(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      "refresh",
      [],
      {
        loadManager: () => Promise.resolve(harness.manager),
        loadPiece: () => Promise.resolve(harness.piece),
        isStdinTerminal: () => true,
      },
    );

    expect(harness.tracker.sendOptions).toEqual([undefined]);
    expect(result.invocation).toBeUndefined();
    expect(harness.tracker.receiptLinkRequested).toBeUndefined();
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
  /** Value the handling's receipt cell reads back ({} = value-less verb). */
  receiptValue?: unknown;
  /** Simulate the create-only receipt collision: commit fails with
   * precondition "receipt-exists" while the link addresses the winner's
   * original receipt. */
  receiptExists?: boolean;
}) {
  const tracker = {
    handlerWrites: [] as Array<{
      cellProp: "input" | "result";
      path: (string | number)[] | undefined;
      value: unknown;
    }>,
    sendOptions: [] as Array<{ eventId?: string } | undefined>,
    receiptLinkRequested: undefined as { id?: string } | undefined,
    idleCalls: 0,
    syncedCalls: 0,
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
              tx: {
                status: () => { status: string; error?: Error };
                handlingReceiptLink?: { id: string; space: string };
              },
            ) => void,
            sendOptions?: { eventId?: string },
          ) => {
            tracker.handlerWrites.push({
              cellProp: "result",
              path: [options.cellKey],
              value,
            });
            tracker.sendOptions.push(sendOptions);
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
                  : options.receiptExists
                  ? {
                    status: "error",
                    error: Object.assign(
                      new Error("Result receipt already exists"),
                      { precondition: "receipt-exists" },
                    ),
                  }
                  : { status: "done" },
              handlingReceiptLink: {
                id: "of:receipt-1",
                space: "did:key:test-home",
              },
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

  const receiptCell = {
    get: () => options.receiptValue,
    pull: () => Promise.resolve(options.receiptValue),
    key: (_key: string) => receiptCell,
  };

  const manager = {
    getSpace: () => "home",
    synced: () => {
      tracker.syncedCalls++;
      return Promise.resolve();
    },
    runtime: {
      [CF_RUNTIME_ERROR_LOG]: runtimeErrors,
      getCellFromLink: (link: { id?: string }) => {
        tracker.receiptLinkRequested = link;
        return receiptCell;
      },
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
        tracker.idleCalls++;
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

describe("forced-stream fallback dispatch", () => {
  /** A verb that defeats ordinary detection — plain object value, no `$stream`
   * marker, no stream schema — but that the forced stream cast proves is a
   * handler. This is the only case `tryResolvePieceHandler` exists for, and
   * the one where the cell that passed detection and the cell built by reading
   * the schema back from links are not interchangeable. */
  function createFallbackHarness() {
    const sends: unknown[] = [];
    const dataWrites: unknown[] = [];

    // The cell the forced cast proves. Only this one dispatches.
    const streamCell = {
      isStream: () => true,
      send: (value: unknown, onCommit?: (tx: unknown) => void) => {
        sends.push(value);
        onCommit?.({ status: () => ({ status: "done" }) });
      },
    };

    // What `rootCell.key(name).asSchemaFromLinks()` yields: carries the
    // published payload schema, but nothing marking it a stream. A real cell
    // here has a `send` that routes to `.set()`'s non-stream branch and
    // throws "Transaction required for .set()".
    // `key()` must yield nothing for "pattern"/"extraParams", or
    // detectCallableKind's tool probe classifies this as a tool and the
    // fallback path under test is never reached.
    const emptyChild = {
      get: () => undefined,
      getRaw: () => undefined,
    };
    const linkDerivedCell = {
      schema: {
        type: "object",
        properties: { note: { type: "string" } },
      } as JSONSchema,
      get: () => ({}),
      getRaw: () => ({}),
      asSchemaFromLinks: () => linkDerivedCell,
      key: () => emptyChild,
    };

    const rootValue = { hiddenPing: {} };
    const rootCell = {
      schema: {
        type: "object",
        properties: { hiddenPing: { type: "object" } },
      } as JSONSchema,
      get: () => rootValue,
      getRaw: () => rootValue,
      asSchemaFromLinks: () => rootCell,
      key: (name: string) => name === "hiddenPing" ? linkDerivedCell : absent,
    };
    // The input root offers nothing, so resolution falls past both ordinary
    // paths to the forced cast.
    const absent: {
      schema?: JSONSchema;
      get: () => unknown;
      getRaw: () => unknown;
      asSchemaFromLinks: () => unknown;
      key: () => unknown;
    } = {
      get: () => undefined,
      getRaw: () => undefined,
      asSchemaFromLinks: () => absent,
      key: () => emptyChild,
    };
    const emptyCell = {
      schema: { type: "object" } as JSONSchema,
      get: () => ({}),
      getRaw: () => ({}),
      asSchemaFromLinks: () => emptyCell,
      key: () => absent,
    };

    const piece = {
      getCell: () => ({
        get: () => rootValue,
        asSchema: () => ({ key: () => streamCell }),
      }),
      input: {
        getCell: () => Promise.resolve(emptyCell),
        set: (value: unknown) => {
          dataWrites.push(value);
          return Promise.resolve();
        },
      },
      result: {
        getCell: () => Promise.resolve(rootCell),
        set: (value: unknown) => {
          dataWrites.push(value);
          return Promise.resolve();
        },
      },
    };

    const manager = {
      getSpace: () => "home",
      synced: async () => {},
      runtime: {
        [CF_RUNTIME_ERROR_LOG]: [] as Array<{ message: string }>,
        idle: async () => {},
      },
    };

    return { sends, dataWrites, piece, manager, linkDerivedCell, streamCell };
  }

  const config = {
    apiUrl: "http://localhost:8000",
    identity: "/tmp/test-identity.pem",
    piece: "fid1:piece-123",
    space: "home",
  };

  it("sends through the cell whose stream-ness was proven, not a link-derived one", async () => {
    const harness = createFallbackHarness();

    const result = await executePieceCallable(
      config,
      "hiddenPing",
      ["--note", "hi"],
      {
        loadManager: () => Promise.resolve(harness.manager as never),
        loadPiece: () => Promise.resolve(harness.piece as never),
        isStdinTerminal: () => true,
      },
    );

    expect(result.resolved.callableKind).toBe("handler");
    // Dispatched as an event through the proven cell. Resolving to the
    // link-derived cell instead leaves a cell that `.set()` treats as data.
    expect(result.resolved.callableCell).toBe(harness.streamCell);
    expect(harness.sends).toEqual([{ note: "hi" }]);
    expect(harness.dataWrites).toEqual([]);
  });

  it("keeps the published payload schema for the command spec", async () => {
    const harness = createFallbackHarness();

    const result = await executePieceCallable(
      config,
      "hiddenPing",
      ["--note", "hi"],
      {
        loadManager: () => Promise.resolve(harness.manager as never),
        loadPiece: () => Promise.resolve(harness.piece as never),
        isStdinTerminal: () => true,
      },
    );

    // The forced cast's own schema is just the stream marker; `--help` and
    // input validation must still see what the piece publishes.
    expect(result.resolved.commandSpec.inputSchema).toEqual(
      harness.linkDerivedCell.schema,
    );
  });
});

describe("piece call stdin payloads", () => {
  it("identifies JSON output without treating delimited fields as selectors", () => {
    expect(
      pieceCallInvocation(["--json", '{"query":"milk"}'], []),
    ).toEqual({
      rawArgs: ["--json", '{"query":"milk"}'],
      jsonOutput: true,
    });
    expect(
      pieceCallInvocation([], ["--json-file", "/tmp/input.json"]),
    ).toEqual({
      rawArgs: ["--json-file", "/tmp/input.json"],
      jsonOutput: true,
    });
    expect(pieceCallInvocation([], ["run", "--json", "{}"])).toEqual({
      rawArgs: ["run", "--json", "{}"],
      jsonOutput: true,
    });
    expect(pieceCallInvocation([], ["--query", "--json"])).toEqual({
      rawArgs: ["--query", "--json"],
      jsonOutput: false,
    });
    expect(
      pieceCallInvocation([], ["invoke", "--query", "--json"]),
    ).toEqual({
      rawArgs: ["invoke", "--query", "--json"],
      jsonOutput: false,
    });
  });

  it("mints an invocation id when none is given and rejects a blank one", () => {
    expect(resolveInvocationId(undefined, () => "minted-1")).toBe("minted-1");
    expect(resolveInvocationId("caller-supplied")).toBe("caller-supplied");
    // A blank id would claim caller-supplied idempotency while carrying
    // nothing that distinguishes deliveries — the retry it promises would
    // not be safe.
    expect(() => resolveInvocationId("")).toThrow(/non-blank id/);
    expect(() => resolveInvocationId("   ")).toThrow(/non-blank id/);
  });

  it("announces the invocation id once, at dispatch", () => {
    const announced: string[] = [];
    const seen: string[] = [];
    const report = invocationPhaseReporter(
      "inv-9",
      (p) => seen.push(p),
      (m) => announced.push(m),
    );
    // Nothing is announced before dispatch: until the event is on its way
    // there is nothing a retry would deduplicate against.
    report("initial_sync");
    expect(announced).toEqual([]);
    report("dispatched");
    expect(announced).toEqual(["invocation: inv-9"]);
    // Later phases, and a second dispatch, must not re-announce — a caller
    // scraping stderr should not have to pick among several ids.
    report("committed");
    report("dispatched");
    report("readback");
    expect(announced).toEqual(["invocation: inv-9"]);
    expect(seen).toEqual([
      "initial_sync",
      "dispatched",
      "committed",
      "dispatched",
      "readback",
    ]);
  });

  it("shapes the settled Invocation JSON an agent parses", () => {
    expect(invocationJson({ id: "inv-1", status: "settled" })).toEqual({
      invocation: "inv-1",
      status: "settled",
    });
    expect(
      invocationJson({ id: "inv-1", status: "settled", deduplicated: true }),
    ).toEqual({
      invocation: "inv-1",
      status: "settled",
      deduplicated: true,
    });
    expect(
      invocationJson({
        id: "inv-1",
        status: "settled",
        result: { commentId: "c-1" },
      }),
    ).toEqual({
      invocation: "inv-1",
      status: "settled",
      result: { commentId: "c-1" },
    });
    // deduplicated: false is never emitted — its absence is the signal.
    expect(
      invocationJson({ id: "inv-1", status: "settled", deduplicated: false }),
    ).not.toHaveProperty("deduplicated");
    // A verb that genuinely returned null keeps it; a value-less verb omits
    // the key entirely, so the two stay distinguishable on the wire.
    expect(invocationJson({ id: "inv-1", status: "settled", result: null }))
      .toEqual({ invocation: "inv-1", status: "settled", result: null });
    expect(
      invocationJson({ id: "inv-1", status: "settled", result: undefined }),
    ).not.toHaveProperty("result");
  });

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

  it("reports transform failures without an unrelated --input hint", () => {
    const transformError = new PieceGetTransformError(
      "--filter can only be applied to an array",
    );
    expect(isPieceGetDataError(transformError)).toBe(true);
    const report = pieceGetDataErrorReport(transformError, {
      input: false,
      piece: "fid1:piece-123",
    });
    expect(report?.message).toBe("--filter can only be applied to an array");
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

describe("piece call input errors", () => {
  it("reports the rejection with a pointer at the verb listing", () => {
    const report = verbInputErrorReport(
      new VerbInputValidationError(
        "recordMessage",
        "missing required property message",
      ),
      { piece: "fid1:piece-123" },
    );
    expect(report?.message).toMatch(/Invalid input for "recordMessage"/);
    expect(report?.message).toMatch(/missing required property message/);
    expect(report?.hint).toMatch(/piece verbs/);
    expect(report?.hint).toMatch(/fid1:piece-123/);
  });

  it("returns null for a non-input error (caller rethrows)", () => {
    expect(
      verbInputErrorReport(new Error("network unreachable"), {
        piece: "fid1:piece-123",
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

describe("verbInputSchemaError", () => {
  const objectSchema: JSONSchema = {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  };

  it("accepts a payload that matches", () => {
    expect(verbInputSchemaError({ message: "milk" }, objectSchema))
      .toBeUndefined();
  });

  it("rejects a missing required property", () => {
    expect(verbInputSchemaError({ mesage: "milk" }, objectSchema))
      .toMatch(/message/);
  });

  it("rejects a payload of the wrong type", () => {
    expect(verbInputSchemaError(["not-an-object"], objectSchema))
      .toMatch(/object/);
  });

  it("leaves an absent payload alone so value-less verbs still send", () => {
    expect(verbInputSchemaError(undefined, objectSchema)).toBeUndefined();
  });

  it("accepts anything when the verb declares no schema", () => {
    expect(verbInputSchemaError({ anything: 1 }, undefined)).toBeUndefined();
    expect(verbInputSchemaError({ anything: 1 }, true)).toBeUndefined();
  });

  // The runtime injects a property's default when the payload omits it, so
  // requiring it here would refuse a call the verb would have accepted. This
  // pins that the gate APPLIES the relaxation; the relaxation's own semantics
  // ($ref chains, combinators, cycles, the `definitions` refusal) are pinned
  // where the helpers live (runner `cfc-defaulted-required-relaxation.test.ts`
  // — verb contract D6).
  it("treats a defaulted property as satisfied when omitted", () => {
    expect(verbInputSchemaError({}, {
      type: "object",
      properties: { mode: { type: "string", default: "fast" } },
      required: ["mode"],
    })).toBeUndefined();
  });

  it("accepts asCell fields given either a plain value or a link", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        target: {
          type: "object",
          properties: { n: { type: "number" } },
          asCell: ["cell"],
        },
      },
      required: ["target"],
    };
    expect(verbInputSchemaError({ target: { n: 1 } }, schema)).toBeUndefined();
    expect(
      verbInputSchemaError(
        { target: { "/": { id: "of:abc", path: [], space: "did:x:y" } } },
        schema,
      ),
    ).toBeUndefined();
  });
});

describe("normalizeAbsentVerbPayload", () => {
  it("normalizes absence to {} against a plain object schema", () => {
    expect(normalizeAbsentVerbPayload(undefined, {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    })).toEqual({});
  });

  it("normalizes absence to {} through a top-level local $ref", () => {
    expect(normalizeAbsentVerbPayload(undefined, {
      $ref: "#/$defs/Event",
      asCell: ["stream"],
      $defs: {
        Event: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
    } as JSONSchema)).toEqual({});
  });

  it("leaves a supplied payload untouched, object schema or not", () => {
    const payload = { message: "milk" };
    expect(normalizeAbsentVerbPayload(payload, {
      type: "object",
      properties: { message: { type: "string" } },
    })).toBe(payload);
    expect(normalizeAbsentVerbPayload("text", { type: "string" })).toBe(
      "text",
    );
  });

  it("leaves absence alone when the verb declares no schema", () => {
    expect(normalizeAbsentVerbPayload(undefined, undefined)).toBeUndefined();
    expect(normalizeAbsentVerbPayload(undefined, true)).toBeUndefined();
  });

  // An absent payload must keep passing a `false` schema — a supplied one is
  // already refused by the validator ("schema rejects all values"), and
  // normalizing here would convert every call into that refusal.
  it("leaves absence alone against a boolean false schema", () => {
    expect(normalizeAbsentVerbPayload(undefined, false)).toBeUndefined();
  });

  it("leaves absence alone against a non-object schema", () => {
    expect(normalizeAbsentVerbPayload(undefined, { type: "string" }))
      .toBeUndefined();
    expect(normalizeAbsentVerbPayload(undefined, {
      type: "array",
      items: { type: "string" },
    })).toBeUndefined();
  });

  // Refuse only on proof: a $ref nobody can resolve proves nothing about the
  // event being an object, so absence keeps today's pass-through behavior.
  it("leaves absence alone when the top-level $ref cannot be resolved", () => {
    expect(normalizeAbsentVerbPayload(undefined, {
      $ref: "#/$defs/Absent",
      asCell: ["stream"],
      $defs: { Present: { type: "object" } },
    } as JSONSchema)).toBeUndefined();
  });

  // A boolean definition is a resolvable target that still proves nothing
  // about the event being an object — absence passes through, like any other
  // non-object target.
  it("leaves absence alone when the top-level $ref names a boolean def", () => {
    expect(normalizeAbsentVerbPayload(undefined, {
      $ref: "#/$defs/Anything",
      asCell: ["stream"],
      $defs: { Anything: true },
    } as JSONSchema)).toBeUndefined();
  });

  // An allOf conjunction with an object-schema branch IS an object schema —
  // no branch choice is involved, so `{}` is exactly as meaningful as for a
  // direct object root, and the gate then judges it the same way (refused
  // when non-defaulted required survives relaxation, dispatched with defaults
  // engaging when it does not).
  it("normalizes absence to {} against an allOf of object schemas", () => {
    expect(normalizeAbsentVerbPayload(undefined, {
      allOf: [
        {
          type: "object",
          properties: { mode: { type: "string", default: "fast" } },
          required: ["mode"],
        },
      ],
    } as unknown as JSONSchema)).toEqual({});
  });

  it("normalizes absence through an allOf branch behind a $ref", () => {
    expect(normalizeAbsentVerbPayload(undefined, {
      allOf: [{ $ref: "#/$defs/Base" }],
      $defs: {
        Base: {
          type: "object",
          properties: { mode: { type: "string", default: "fast" } },
        },
      },
    } as unknown as JSONSchema)).toEqual({});
  });

  // Disjunctive roots stay out of scope (the D5 rule's recorded combinator
  // boundary): normalizing `{}` against anyOf/oneOf would pick among
  // alternatives on the caller's behalf.
  it("leaves absence alone against anyOf/oneOf roots", () => {
    expect(normalizeAbsentVerbPayload(undefined, {
      anyOf: [{ type: "object", properties: {} }],
    } as unknown as JSONSchema)).toBeUndefined();
    expect(normalizeAbsentVerbPayload(undefined, {
      oneOf: [{ type: "object", properties: {} }],
    } as unknown as JSONSchema)).toBeUndefined();
  });

  // The schema-less handler-input shape (`{ asCell: ["stream"] }` with no
  // type and no properties) is not an object schema; `{}` means nothing
  // there.
  it("leaves absence alone against a schema-less stream marker", () => {
    expect(normalizeAbsentVerbPayload(undefined, {
      asCell: ["stream"],
    } as JSONSchema)).toBeUndefined();
  });
});

describe("reportVerbInputErrorOrRethrow", () => {
  const sink = () => {
    const printed: string[] = [];
    const exited: number[] = [];
    return {
      printed,
      exited,
      deps: {
        printError: (m: string) => printed.push(`error:${m}`),
        printHint: (m: string) => printed.push(`hint:${m}`),
        exit: ((code: number) => {
          exited.push(code);
          throw new Error("exit-sentinel");
        }) as (code: number) => never,
      },
    };
  };

  it("reports a rejected payload and exits 1", () => {
    const { printed, exited, deps } = sink();

    expect(() =>
      reportVerbInputErrorOrRethrow(
        new VerbInputValidationError(
          "recordMessage",
          "missing required property message",
        ),
        "fid1:piece-123",
        deps,
      )
    ).toThrow("exit-sentinel");

    expect(printed[0]).toMatch(/Invalid input for "recordMessage"/);
    expect(printed[1]).toMatch(/piece verbs/);
    expect(printed[1]).toMatch(/fid1:piece-123/);
    expect(exited).toEqual([1]);
  });

  it("names the piece as <piece> when the config carries none", () => {
    const { printed, deps } = sink();

    expect(() =>
      reportVerbInputErrorOrRethrow(
        new VerbInputValidationError("recordMessage", "bad"),
        undefined,
        deps,
      )
    ).toThrow("exit-sentinel");

    expect(printed[1]).toMatch(/<piece>/);
  });

  // Anything that is not an input rejection has to keep travelling: a network
  // failure reported as a payload problem would send an agent to fix a payload
  // that was fine.
  it("re-throws an unrelated failure untouched", () => {
    const { printed, exited, deps } = sink();
    const original = new Error("network unreachable");

    expect(() =>
      reportVerbInputErrorOrRethrow(original, "fid1:piece-123", deps)
    )
      .toThrow("network unreachable");

    expect(printed).toEqual([]);
    expect(exited).toEqual([]);
  });
});
