import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import { listPieceCallables, partitionVerbListing } from "../lib/piece.ts";

const TEST_PATTERN_REF = {
  source: {
    ref: "sha256:deadbeef",
    repository: "labs",
    entry: "packages/patterns/topics/main.tsx",
  },
} as never;

/** Minimal schema-aware cell double: enough surface for the lister's walk —
 * value/schema access, key() descent, and asSchemaFromLinks identity. */
function cell(value: unknown, schema?: JSONSchema): {
  schema?: JSONSchema;
  get: () => unknown;
  getRaw: () => unknown;
  asSchemaFromLinks: () => unknown;
  key: (name: string) => unknown;
} {
  const self = {
    schema,
    get: () => value,
    getRaw: () => value,
    asSchemaFromLinks: () => self,
    key: (name: string) => {
      const childValue =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)[name]
          : undefined;
      const childSchema =
        schema && typeof schema === "object" && "properties" in schema
          ? (schema.properties as Record<string, JSONSchema>)?.[name]
          : undefined;
      return cell(childValue, childSchema);
    },
  };
  return self;
}

const ADD_TOPIC_EVENT: JSONSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    body: { type: "string" },
    agentName: { type: "string" },
  },
  required: ["title"],
};

const SEARCH_ARGUMENTS: JSONSchema = {
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
};

const SEARCH_RESULT: JSONSchema = {
  type: "object",
  properties: { summary: { type: "string" } },
};

const CREATE_NOTE_RESULT: JSONSchema = {
  type: "object",
  properties: { note: { type: "object" } },
  required: ["note"],
};

/** One compiled result property as the builder serializes a stream: an alias
 * to a derived internal cell, named by its cause. Taken from what
 * `patternManager.compilePattern` actually emits for a CTS `action` — both the
 * result property and the handler node's `$event` carry this same shape. */
function streamAlias(cause: unknown, schema: JSONSchema | true = true) {
  return { $alias: { partialCause: cause, scope: "space", path: [], schema } };
}

/** A compiled pattern double. `getPattern()` resolves a real `Pattern`, which
 * is CALLABLE with `result`/`nodes` hung off it — a plain object here would
 * pass a lister that rejects the shape the runtime actually hands it. */
function compiledPattern(
  graph: { result: Record<string, unknown>; nodes: unknown[] },
) {
  return Object.assign(() => {}, graph);
}

describe("listPieceCallables", () => {
  it("lists handlers and tools with schemas; excludes data; result shadows input", async () => {
    const resultRoot = cell(
      {
        addTopic: { $stream: true },
        search: {
          pattern: {
            argumentSchema: SEARCH_ARGUMENTS,
            resultSchema: SEARCH_RESULT,
          },
          extraParams: { source: "bound-source" },
        },
        topicCount: 3,
      },
      {
        type: "object",
        properties: {
          addTopic: ADD_TOPIC_EVENT,
          search: {
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
          },
          topicCount: { type: "number" },
        },
      },
    );
    // `addTopic` also present input-side: the result-side entry must win,
    // matching `cf piece call`'s result-then-input resolution order.
    const inputRoot = cell(
      {
        addTopic: { $stream: true },
        setup: { $stream: true },
      },
      {
        type: "object",
        properties: {
          addTopic: { type: "object" },
          setup: { type: "object", properties: { seed: { type: "string" } } },
        },
      },
    );

    // "hiddenPing" carries no stream signal at all — a plain object value and
    // a plain object schema — so it is data as far as anything stored can tell,
    // and the listing must NOT include it. The forced-stream cast used to find
    // it, by asserting a stream schema and then asking whether the schema said
    // stream. `asSchema` below is kept for exactly that reason: the double
    // still answers "stream" to any cast, so its presence proves the listing no
    // longer asks. "\u00e9dit" does carry the `{$stream: true}` sentinel, which
    // is a definite stored signal, so it stays listed — and it pins byte
    // ordering: utf8Compare puts it AFTER "setup"/"search" (0xC3 > s), where
    // locale collation would interleave it linguistically.
    const pieceRootValue = { hiddenPing: {}, "\u00e9dit": { $stream: true } };
    const piece = {
      result: { getCell: () => Promise.resolve(resultRoot) },
      input: { getCell: () => Promise.resolve(inputRoot) },
      getPatternRef: () => Promise.resolve(TEST_PATTERN_REF),
      getCell: () => ({
        get: () => pieceRootValue,
        asSchema: (_s: unknown) => ({
          key: (name: string) => ({
            isStream: () => name === "hiddenPing" || name === "\u00e9dit",
          }),
        }),
      }),
    };
    const manager = { getSpace: () => "home" };

    const listing = await listPieceCallables(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      {
        loadPieces: () => Promise.resolve(manager as never),
        loadPiece: () => Promise.resolve(piece as never),
      },
    );

    // The deployed pattern's identity rides the listing — the skew detector.
    expect(listing.pattern).toEqual(TEST_PATTERN_REF);
    const verbs = listing.verbs;
    expect(verbs.map((v) => v.name)).toEqual([
      "addTopic",
      "search",
      "setup",
      "\u00e9dit",
    ]);
    // Named explicitly, because the whole defect was a name like this being
    // offered to a caller as callable when calling it is a silent no-op.
    expect(verbs.some((v) => v.name === "hiddenPing")).toBe(false);

    const [addTopic, search, setup, accented] = verbs;
    // A sentinel-bearing name found only on the piece root is listed as a
    // handler on the result cell, exactly as tryResolvePieceHandler dispatches
    // it.
    expect(accented.kind).toBe("handler");
    expect(accented.on).toBe("result");
    expect(addTopic).toEqual({
      name: "addTopic",
      kind: "handler",
      on: "result",
      inputSchema: ADD_TOPIC_EVENT,
    });
    expect(search.kind).toBe("tool");
    expect(search.on).toBe("result");
    expect(search.inputSchema).toEqual(SEARCH_ARGUMENTS);
    expect(search.outputSchema).toEqual(SEARCH_RESULT);
    expect(setup.kind).toBe("handler");
    expect(setup.on).toBe("input");
    // Plain data is not a verb.
    expect(verbs.some((v) => v.name === "topicCount")).toBe(false);
  });

  it("reports a handler's declared result as its outputSchema", async () => {
    // A handler's declared result is not on its cell — it rides the module of
    // the node the handler compiled to. The listing finds that node by
    // matching its `$event` input against the result property exposing the
    // same stream, so `publicName` below resolves through its CAUSE and not
    // through its property name: the two deliberately disagree, because a
    // name-keyed lookup would answer every other case in this test correctly.
    const resultRoot = cell(
      {
        createNote: { $stream: true },
        touch: { $stream: true },
        publicName: { $stream: true },
        shared: { $stream: true },
      },
      {
        type: "object",
        properties: {
          createNote: ADD_TOPIC_EVENT,
          touch: { type: "object" },
          publicName: { type: "object" },
          shared: { type: "object" },
        },
      },
    );
    const pattern = compiledPattern({
      result: {
        createNote: streamAlias({ stream: "createNote" }, ADD_TOPIC_EVENT),
        touch: streamAlias({ stream: "touch" }),
        publicName: streamAlias({ stream: "internalCause" }),
        shared: streamAlias({ stream: "shared" }),
        noteCount: streamAlias("noteCount", { type: "number" }),
      },
      nodes: [
        {
          module: { wrapper: "handler", resultSchema: CREATE_NOTE_RESULT },
          // The event link carries the schema for the position it is read at;
          // identity is the cause, so a differing schema must not defeat the
          // match.
          inputs: { $event: streamAlias({ stream: "createNote" }) },
          outputs: {},
        },
        // Declares nothing: the value-less shape.
        {
          module: { wrapper: "handler" },
          inputs: { $event: streamAlias({ stream: "touch" }) },
          outputs: {},
        },
        {
          module: { wrapper: "handler", resultSchema: SEARCH_RESULT },
          inputs: { $event: streamAlias({ stream: "internalCause" }) },
          outputs: {},
        },
        // Two handlers on one stream: nothing names a single verb's result,
        // so the row keeps none rather than picking a winner.
        {
          module: { wrapper: "handler", resultSchema: SEARCH_RESULT },
          inputs: { $event: streamAlias({ stream: "shared" }) },
          outputs: {},
        },
        {
          module: { wrapper: "handler" },
          inputs: { $event: streamAlias({ stream: "shared" }) },
          outputs: {},
        },
        // A compute node over ordinary data — no `$event` at all.
        {
          module: { type: "javascript", resultSchema: { type: "number" } },
          inputs: { list: streamAlias("notes") },
          outputs: streamAlias("noteCount"),
        },
      ],
    });
    const piece = {
      result: { getCell: () => Promise.resolve(resultRoot) },
      input: { getCell: () => Promise.resolve(cell(undefined, undefined)) },
      getPattern: () => Promise.resolve(pattern),
    };
    const listing = await listPieceCallables(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-789",
        space: "home",
      },
      {
        loadPieces: () => Promise.resolve({} as never),
        loadPiece: () => Promise.resolve(piece as never),
      },
    );

    const byName = new Map(listing.verbs.map((verb) => [verb.name, verb]));
    expect(byName.get("createNote")?.outputSchema).toEqual(CREATE_NOTE_RESULT);
    expect(byName.get("publicName")?.outputSchema).toEqual(SEARCH_RESULT);
    expect(byName.get("touch")?.outputSchema).toBeUndefined();
    expect(byName.get("shared")?.outputSchema).toBeUndefined();
    // A declared result is an own property only when there is one: a row with
    // no result must not carry the key at all.
    expect(Object.hasOwn(byName.get("touch")!, "outputSchema")).toBe(false);
    // Data stays out of the listing whatever its node declares.
    expect(byName.has("noteCount")).toBe(false);
  });

  it("lists a piece whose pattern cannot be resolved", async () => {
    // The graph is advisory the way the source identity is: without it a row
    // loses its declared result, never its place in the listing.
    const resultRoot = cell(
      { createNote: { $stream: true } },
      { type: "object", properties: { createNote: ADD_TOPIC_EVENT } },
    );
    const piece = {
      result: { getCell: () => Promise.resolve(resultRoot) },
      input: { getCell: () => Promise.resolve(cell(undefined, undefined)) },
      getPattern: () =>
        Promise.reject(new Error("piece missing pattern identity")),
    };
    const listing = await listPieceCallables(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-790",
        space: "home",
      },
      {
        loadPieces: () => Promise.resolve({} as never),
        loadPiece: () => Promise.resolve(piece as never),
      },
    );
    expect(listing.verbs.map((verb) => verb.name)).toEqual(["createNote"]);
    expect(listing.verbs[0].outputSchema).toBeUndefined();
  });

  it("returns an empty list for a piece with no callables", async () => {
    const piece = {
      result: {
        getCell: () =>
          Promise.resolve(
            cell({ title: "x" }, {
              type: "object",
              properties: { title: { type: "string" } },
            }),
          ),
      },
      input: { getCell: () => Promise.resolve(cell({})) },
    };
    const listing = await listPieceCallables(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-456",
        space: "home",
      },
      {
        loadPieces: () => Promise.resolve({ getSpace: () => "home" } as never),
        loadPiece: () => Promise.resolve(piece as never),
      },
    );
    // No getPatternRef on the double: identity degrades to null, honestly.
    expect(listing.pattern).toBeNull();
    expect(listing.verbs).toEqual([]);
  });

  it("carries the listing marks off the durable schema", async () => {
    // The generator emits `tier: "wrapper"` (session-scope inference) and
    // `deprecated: true` (@deprecated JSDoc) onto stream properties; the
    // listing surfaces them so the verbs command can hide marked rows by
    // default. `cf piece call` never consults them — everything stays
    // callable, which is why the marks ride the LISTING rather than the
    // dispatcher.
    const resultRoot = cell(
      {
        addTopic: { $stream: true },
        submitTopic: { $stream: true },
        setMyName: { $stream: true },
      },
      {
        type: "object",
        properties: {
          addTopic: ADD_TOPIC_EVENT,
          submitTopic: { type: "object", tier: "wrapper" },
          setMyName: { type: "object", deprecated: true },
        },
      },
    );
    const piece = {
      result: { getCell: () => Promise.resolve(resultRoot) },
      input: { getCell: () => Promise.resolve(cell(undefined, undefined)) },
    };
    const listing = await listPieceCallables(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-123",
        space: "home",
      },
      {
        loadPieces: () => Promise.resolve({} as never),
        loadPiece: () => Promise.resolve(piece as never),
      },
    );
    const byName = new Map(listing.verbs.map((verb) => [verb.name, verb]));
    expect(byName.get("addTopic")?.tier).toBeUndefined();
    expect(byName.get("addTopic")?.deprecated).toBeUndefined();
    expect(byName.get("submitTopic")?.tier).toBe("wrapper");
    expect(byName.get("setMyName")?.deprecated).toBe(true);

    // The default partition: marked rows hide, counted per axis; the shown
    // set keeps its order and the marks stay on the hidden rows.
    const partition = partitionVerbListing(listing.verbs);
    expect(partition.shown.map((verb) => verb.name)).toEqual(["addTopic"]);
    expect(partition.wrapper).toBe(1);
    expect(partition.deprecated).toBe(1);
  });
});
