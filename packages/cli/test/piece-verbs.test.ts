import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import type { PieceCallablesListing } from "../lib/piece.ts";
import { listPieceCallables, partitionVerbListing } from "../lib/piece.ts";
import { verbListingJson, verbListingLines } from "../commands/piece.ts";

const TEST_PATTERN_REF = {
  source: {
    ref: "sha256:deadbeef",
    repository: "labs",
    entry: "packages/patterns/topics/main.tsx",
  },
} as never;

/**
 * `asSchema()` as the lister uses it: one handle per stored name, which is
 * what a root read through `additionalProperties: {asCell: ["cell"]}` answers.
 * Doubling it rather than `get()` is the point — a real cell mints those
 * handles without materializing anything under them, and the lister must not
 * need more than that to enumerate.
 */
function namedHandles(
  value: unknown,
  child: (name: string) => unknown,
): { get: () => unknown } {
  const named = typeof value === "object" && value !== null &&
      !Array.isArray(value)
    ? Object.fromEntries(
      Object.keys(value as Record<string, unknown>).map((
        name,
      ) => [name, child(name)]),
    )
    : undefined;
  return { get: () => named };
}

/**
 * A piece-root cell double, with two traps in it.
 *
 * `get()` throws: the lister enumerates this root through the shallow read and
 * classifies each name off its own cell, so projecting the whole root is a
 * defect however cheap this double makes it look.
 *
 * The handles the shallow read hands back answer `isStream()` TRUE for every
 * name — the forced-cast behavior a real cell shows once a caller asserts a
 * stream schema on it. Enumeration is all they are for. A listing that
 * classifies from them instead of from each name's own `asSchemaFromLinks()`
 * cell offers every stored name as a verb, which the assertions on
 * `hiddenPing` catch.
 */
function pieceRootCell(value: Record<string, unknown>): {
  get: () => unknown;
  getRaw: () => unknown;
  asSchema: (schema: unknown) => { get: () => unknown };
  key: (name: string) => unknown;
} {
  const honestChild = (name: string) => {
    const self = {
      get: () => value[name],
      getRaw: () => value[name],
      // Nothing here is link-derived, so only a stored sentinel classifies.
      isStream: () => false,
      asSchemaFromLinks: () => self,
    };
    return self;
  };
  const castChild = (name: string) => {
    const self = {
      get: () => value[name],
      getRaw: () => value[name],
      isStream: () => true,
      asSchemaFromLinks: () => self,
    };
    return self;
  };
  return {
    get: () => {
      throw new Error("projected the whole piece root");
    },
    getRaw: () => value,
    asSchema: (_schema: unknown) => namedHandles(value, castChild),
    key: honestChild,
  };
}

/** Minimal schema-aware cell double: enough surface for the lister's walk —
 * value/schema access, key() descent, and asSchemaFromLinks identity. */
function cell(value: unknown, schema?: JSONSchema): {
  schema?: JSONSchema;
  get: () => unknown;
  getRaw: () => unknown;
  asSchema: (schema: unknown) => { get: () => unknown };
  asSchemaFromLinks: () => unknown;
  key: (name: string) => unknown;
} {
  const self = {
    schema,
    get: () => value,
    getRaw: () => value,
    asSchema: (_schema: unknown) => namedHandles(value, self.key),
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

/** A result cell as a `cf` command is actually handed one: `get()` and
 * `schema` offer only what the pattern's declared result TYPE carries, while
 * `key()` still reaches every stored property. `streams` names the properties
 * whose stored cell answers as a stream; every other child answers no, which
 * is what makes this double able to refuse — the forced-stream cast the
 * listing must not use would get "yes" from all of them. */
function schemaFilteredCell(
  value: Record<string, unknown>,
  schema: JSONSchema,
  streams: ReadonlySet<string>,
): {
  schema: JSONSchema;
  get: () => unknown;
  getRaw: () => unknown;
  asSchema: (schema: unknown) => { get: () => unknown };
  asSchemaFromLinks: () => unknown;
  key: (name: string) => unknown;
} {
  const child = (name: string) => {
    const self = {
      schema: undefined,
      get: () => undefined,
      getRaw: () => undefined,
      isStream: () => streams.has(name),
      asSchemaFromLinks: () => self,
      key: () => self,
    };
    return self;
  };
  return {
    schema,
    get: () => value,
    getRaw: () => value,
    asSchema: (_schema: unknown) => namedHandles(value, child),
    asSchemaFromLinks: function () {
      return this;
    },
    key: child,
  };
}

/** The same schema-filtered result cell, with an event schema on each hidden
 * stream's callable cell. That schema is what `callableCommandSpec` publishes
 * as a handler row's `inputSchema`, so it is what tells a result-side row
 * apart from a same-named input-side one — a test that only counted rows
 * could not see the two swap. `noteCount` is the declared result type's whole
 * content, and answers no to `isStream` like any data field. */
function resultCellWithHiddenStreams(hidden: Record<string, JSONSchema>): {
  schema: JSONSchema;
  get: () => unknown;
  getRaw: () => unknown;
  asSchema: (schema: unknown) => { get: () => unknown };
  asSchemaFromLinks: () => unknown;
  key: (name: string) => unknown;
} {
  const child = (name: string) => {
    const self = {
      schema: hidden[name],
      get: () => undefined,
      getRaw: () => undefined,
      isStream: () => Object.hasOwn(hidden, name),
      asSchemaFromLinks: () => self,
      key: () => self,
    };
    return self;
  };
  const value = { noteCount: 3 };
  return {
    schema: {
      type: "object",
      properties: { noteCount: { type: "number" } },
    },
    get: () => value,
    getRaw: () => value,
    asSchema: (_schema: unknown) => namedHandles(value, child),
    asSchemaFromLinks: function () {
      return this;
    },
    key: child,
  };
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

/** Two event schemas that cannot be mistaken for one another: a row carrying
 * one names which cell the listing reached the verb on. */
const RESULT_SIDE_EVENT: JSONSchema = {
  type: "object",
  properties: { note: { type: "string" } },
  required: ["note"],
};

const INPUT_SIDE_EVENT: JSONSchema = {
  type: "object",
  properties: { seed: { type: "number" } },
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
  it("loads the addressed piece without starting it or the space root", async () => {
    const resultRoot = cell(
      { addTopic: { $stream: true } },
      {
        type: "object",
        properties: { addTopic: ADD_TOPIC_EVENT },
      },
    );
    const inputRoot = cell(undefined, undefined);
    const pieceRoot = {
      ...pieceRootCell({ addTopic: { $stream: true } }),
      entityId: { "/": "fid1:piece-stored" },
    };
    const getPieceCellCalls: unknown[][] = [];
    let ensureCalls = 0;
    const manager = {
      ensureDefaultPattern: () => {
        ensureCalls++;
        return Promise.resolve();
      },
      getPieceCell: (...args: unknown[]) => {
        getPieceCellCalls.push(args);
        return Promise.resolve(pieceRoot);
      },
      getResult: () => resultRoot,
      getArgument: () => inputRoot,
      getSpace: () => "home",
    };

    const listing = await listPieceCallables(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-stored",
        space: "home",
      },
      { loadPieces: () => Promise.resolve(manager as never) },
    );

    expect(ensureCalls).toBe(0);
    expect(getPieceCellCalls).toEqual([
      [
        "fid1:piece-stored",
        { reconcile: true, start: false },
        undefined,
        undefined,
      ],
    ]);
    expect(listing.verbs.map((verb) => verb.name)).toEqual(["addTopic"]);
  });

  it("loads the pattern reference and compiled pattern concurrently", async () => {
    const resultRoot = cell(
      { addTopic: { $stream: true } },
      {
        type: "object",
        properties: { addTopic: ADD_TOPIC_EVENT },
      },
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    const started: string[] = [];
    const piece = {
      result: { getCell: () => Promise.resolve(resultRoot) },
      input: { getCell: () => Promise.resolve(cell(undefined, undefined)) },
      getCell: () => resultRoot,
      getPatternRef: async () => {
        started.push("reference");
        await gate;
        return TEST_PATTERN_REF;
      },
      getPattern: async () => {
        started.push("compiled");
        await gate;
        return compiledPattern({ result: {}, nodes: [] });
      },
    };

    const pending = listPieceCallables(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-stored",
        space: "home",
      },
      {
        loadPieces: () => Promise.resolve({ getSpace: () => "home" } as never),
        loadPiece: () => Promise.resolve(piece as never),
      },
    );
    for (let i = 0; i < 10 && started.length < 2; i++) await Promise.resolve();
    const beforeRelease = [...started].sort();
    release();

    expect(beforeRelease).toEqual(["compiled", "reference"]);
    await pending;
  });

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
    // and the listing must NOT include it. A forced-stream cast finds it, by
    // asserting a stream schema and then asking whether the schema says
    // stream; the piece-root double answers "stream" to any cast — see
    // `pieceRootCell` — so a listing that classifies from the handles it
    // enumerates rather than from each name's own cell offers this row.
    // "\u00e9dit" does carry the `{$stream: true}` sentinel, which
    // is a definite stored signal, so it stays listed — and it pins byte
    // ordering: utf8Compare puts it AFTER "setup"/"search" (0xC3 > s), where
    // locale collation would interleave it linguistically.
    const pieceRootValue = { hiddenPing: {}, "\u00e9dit": { $stream: true } };
    const piece = {
      result: { getCell: () => Promise.resolve(resultRoot) },
      input: { getCell: () => Promise.resolve(inputRoot) },
      getPatternRef: () => Promise.resolve(TEST_PATTERN_REF),
      getCell: () => pieceRootCell(pieceRootValue),
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

  it("lists a graph verb the result cell omits, and only if it is stored", async () => {
    // The result cell reads through the pattern's DECLARED result type, so a
    // verb that type omits appears in neither the value nor the durable
    // schema — the walk is never offered the name at all, which is a different
    // failure from classifying it wrongly. The graph names it, so the graph is
    // a candidate source.
    //
    // It is a candidate source and not a verdict, which `ghostVerb` is here to
    // hold: the graph wires a handler to it exactly as it does `hiddenVerb`,
    // but the piece stores no stream there, so it must not be listed. Without
    // that second gate the graph becomes a way to name rows nobody can call —
    // the direction #5683 closed, reopened from the other end.
    const streams = new Set(["hiddenVerb"]);
    const resultRoot = schemaFilteredCell(
      { noteCount: 3 },
      { type: "object", properties: { noteCount: { type: "number" } } },
      streams,
    );
    const pattern = compiledPattern({
      result: {
        hiddenVerb: streamAlias({ stream: "hiddenVerb" }),
        ghostVerb: streamAlias({ stream: "ghostVerb" }),
        noteCount: streamAlias("noteCount", { type: "number" }),
      },
      nodes: [
        {
          module: { wrapper: "handler", resultSchema: CREATE_NOTE_RESULT },
          inputs: { $event: streamAlias({ stream: "hiddenVerb" }) },
          outputs: {},
        },
        {
          module: { wrapper: "handler" },
          inputs: { $event: streamAlias({ stream: "ghostVerb" }) },
          outputs: {},
        },
        // Ordinary data: no `$event`, so never a candidate in the first place.
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
      getCell: () => resultRoot,
      getPattern: () => Promise.resolve(pattern),
    };
    const listing = await listPieceCallables(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-791",
        space: "home",
      },
      {
        loadPieces: () => Promise.resolve({} as never),
        loadPiece: () => Promise.resolve(piece as never),
      },
    );

    // One row for three graph properties. Enumerating from the result cell
    // alone drops `hiddenVerb` and the list is empty; listing on the graph's
    // say-so adds `ghostVerb`; classifying on the forced-stream cast adds
    // `noteCount` as well.
    expect(listing.verbs.map((verb) => verb.name)).toEqual(["hiddenVerb"]);
    // The row is complete, not a stub: a graph candidate claims its declared
    // result on the same terms a result-cell row does.
    expect(listing.verbs[0]).toEqual({
      name: "hiddenVerb",
      kind: "handler",
      on: "result",
      inputSchema: true,
      outputSchema: CREATE_NOTE_RESULT,
    });
    // The graph WAS read, so the listing claims to be the whole surface. An
    // implementation that reports `incomplete` unconditionally, or that reads
    // the flag off anything other than whether the pattern resolved, fails
    // here rather than only in the paired case below.
    expect(listing.incomplete).toBeUndefined();
  });

  it("reports the listing as incomplete when the pattern cannot be read", async () => {
    // The paired failure of the case above, and the reason the pattern is not
    // advisory here the way the source identity is. `getPattern` rejects on a
    // real piece that carries no pattern identity and on one whose source will
    // not load in this space, and in both the piece still DISPATCHES every
    // verb — resolution never consults the graph. So the listing keeps
    // answering. What it must not do is answer as though it had looked
    // everywhere: `hiddenVerb` is named by the graph alone, so it is gone, and
    // a caller reading this listing would otherwise conclude the piece has
    // nothing to call.
    const streams = new Set(["hiddenVerb"]);
    const resultRoot = schemaFilteredCell(
      { noteCount: 3 },
      { type: "object", properties: { noteCount: { type: "number" } } },
      streams,
    );
    const piece = {
      result: { getCell: () => Promise.resolve(resultRoot) },
      input: { getCell: () => Promise.resolve(cell(undefined, undefined)) },
      getCell: () => resultRoot,
      getPattern: () =>
        Promise.reject(new Error("could not load pattern sha256:x#default")),
    };
    const listing = await listPieceCallables(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-792",
        space: "home",
      },
      {
        loadPieces: () => Promise.resolve({} as never),
        loadPiece: () => Promise.resolve(piece as never),
      },
    );

    // The loss is real and is not recoverable — no second source names a verb
    // the declared result type omits.
    expect(listing.verbs).toEqual([]);
    // ...so the listing says it is a lower bound. This is what fails against a
    // `catch {}` that leaves the candidate names empty and returns the short
    // list as though it were the surface: `incomplete` is undefined there, and
    // an empty listing is indistinguishable from a piece with no verbs.
    expect(listing.incomplete).toBe("pattern-unavailable");
  });

  it("gives a result-side callable the row when an input callable shares its name", async () => {
    // `resolvePieceCallable` tries the result cell first and only reaches the
    // input cell `if (!onResultCell)`. The listing must draw the same line,
    // and the case where it is hardest to draw is exactly the one this change
    // created: the result walk cannot SEE a verb the declared result type
    // omits, so the input walk gets there first and the graph candidate then
    // finds the name already listed.
    //
    // `notify` is stored on both cells with different event schemas. The
    // dispatcher sends a payload shaped by RESULT_SIDE_EVENT, so a listing
    // publishing INPUT_SIDE_EVENT hands a caller the wrong shape for the verb
    // it will actually reach — a disagreement, not merely a mislabel.
    const resultRoot = resultCellWithHiddenStreams({
      notify: RESULT_SIDE_EVENT,
    });
    const inputRoot = cell(
      { notify: { $stream: true } },
      { type: "object", properties: { notify: INPUT_SIDE_EVENT } },
    );
    const pattern = compiledPattern({
      result: {
        notify: streamAlias({ stream: "notify" }),
        noteCount: streamAlias("noteCount", { type: "number" }),
      },
      nodes: [
        {
          module: { wrapper: "handler", resultSchema: CREATE_NOTE_RESULT },
          inputs: { $event: streamAlias({ stream: "notify" }) },
          outputs: {},
        },
      ],
    });
    const piece = {
      result: { getCell: () => Promise.resolve(resultRoot) },
      input: { getCell: () => Promise.resolve(inputRoot) },
      getCell: () => resultRoot,
      getPattern: () => Promise.resolve(pattern),
    };
    const listing = await listPieceCallables(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-794",
        space: "home",
      },
      {
        loadPieces: () => Promise.resolve({} as never),
        loadPiece: () => Promise.resolve(piece as never),
      },
    );

    // One row, not two: a name resolves to one callable.
    expect(listing.verbs.map((verb) => verb.name)).toEqual(["notify"]);
    // Fails against a sweep whose guards skip a name already listed — the
    // input row survives and reports `on: "input"`.
    expect(listing.verbs[0].on).toBe("result");
    // And the assertion that makes the row's identity load-bearing rather
    // than its label: a listing left reporting the input row publishes
    // INPUT_SIDE_EVENT for a verb the dispatcher reaches with
    // RESULT_SIDE_EVENT.
    expect(listing.verbs[0].inputSchema).toEqual(RESULT_SIDE_EVENT);
    // The declared result rides the replacement, as on any result-side row.
    expect(listing.verbs[0].outputSchema).toEqual(CREATE_NOTE_RESULT);
  });

  it("keeps an input row when nothing on the result cell classifies the name", async () => {
    // The other side of the precedence, and what stops "the graph wins" from
    // passing for a fix. `resolvePieceCallable` reaches the piece root's
    // forced-stream probe only after the INPUT cell declines, so an input row
    // outranks a piece-root sentinel and yields only to the result cell.
    //
    // `graphOnly` is a graph result property and an input verb, with nothing
    // stored at it on the result cell. `rootOnly` is a piece-root sentinel and
    // an input verb, likewise. The dispatcher resolves both on the input cell,
    // so both must keep reporting `on: "input"` with the input event schema.
    const resultRoot = resultCellWithHiddenStreams({});
    const inputRoot = cell(
      { graphOnly: { $stream: true }, rootOnly: { $stream: true } },
      {
        type: "object",
        properties: {
          graphOnly: INPUT_SIDE_EVENT,
          rootOnly: INPUT_SIDE_EVENT,
        },
      },
    );
    const pattern = compiledPattern({
      result: {
        graphOnly: streamAlias({ stream: "graphOnly" }),
        noteCount: streamAlias("noteCount", { type: "number" }),
      },
      nodes: [
        {
          module: { wrapper: "handler" },
          inputs: { $event: streamAlias({ stream: "graphOnly" }) },
          outputs: {},
        },
      ],
    });
    const piece = {
      result: { getCell: () => Promise.resolve(resultRoot) },
      input: { getCell: () => Promise.resolve(inputRoot) },
      getCell: () => pieceRootCell({ rootOnly: { $stream: true } }),
      getPattern: () => Promise.resolve(pattern),
    };
    const listing = await listPieceCallables(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-795",
        space: "home",
      },
      {
        loadPieces: () => Promise.resolve({} as never),
        loadPiece: () => Promise.resolve(piece as never),
      },
    );

    const byName = new Map(listing.verbs.map((verb) => [verb.name, verb]));
    expect([...byName.keys()].sort()).toEqual(["graphOnly", "rootOnly"]);
    // `graphOnly` fails against a fix that lets any graph candidate replace an
    // input row: the graph names it, but the result cell stores nothing there,
    // so the dispatcher never leaves the input cell.
    expect(byName.get("graphOnly")?.on).toBe("input");
    expect(byName.get("graphOnly")?.inputSchema).toEqual(INPUT_SIDE_EVENT);
    // `rootOnly` fails against a fix that replaces an input row on ANY stored
    // signal rather than on the result cell's: the piece-root sentinel does
    // classify, and ranking it above the input row inverts
    // `onInputCell ?? tryResolvePieceHandler(...)`.
    expect(byName.get("rootOnly")?.on).toBe("input");
    expect(byName.get("rootOnly")?.inputSchema).toEqual(INPUT_SIDE_EVENT);
  });

  it("lists without ever projecting a whole root", async () => {
    // Cost, pinned as behavior: listing cost is independent of what the piece
    // holds, so the walk must not call `get()` on a root. A projected root
    // read walks every document the result type reaches, which would make
    // listing a board's verbs scale with the number of rows on it — for an
    // answer that is a handful of top-level names. Every root here refuses
    // `get()` outright, so the walk completes only off the shallow name read
    // and each name's own cell.
    const trap = (name: string) => () => {
      throw new Error(`projected the whole ${name} root`);
    };
    // `undeclared` is stored and absent from the schema, so it reaches the
    // listing only through the shallow name read — which is what keeps this
    // test honest about enumeration rather than passing on schema keys alone.
    const storedResult: Record<string, unknown> = {
      addTopic: { $stream: true },
      undeclared: { $stream: true },
      topicCount: 3,
    };
    const resultChild = (name: string) => {
      const self = {
        schema: undefined,
        get: trap(`result/${name}`),
        getRaw: () => storedResult[name],
        asSchemaFromLinks: () => self,
        key: () => self,
      };
      return self;
    };
    const resultRoot = {
      schema: {
        type: "object",
        properties: {
          addTopic: ADD_TOPIC_EVENT,
          topicCount: { type: "number" },
        },
      } as JSONSchema,
      get: trap("result"),
      asSchema: (_s: unknown) => namedHandles(storedResult, resultChild),
      asSchemaFromLinks: function () {
        return this;
      },
      key: resultChild,
    };
    const emptyRoot = (label: string) => ({
      schema: undefined,
      get: trap(label),
      asSchema: (_s: unknown) => namedHandles(undefined, () => undefined),
      asSchemaFromLinks: function () {
        return this;
      },
      key: () => ({
        get: trap(`${label} child`),
        getRaw: () => undefined,
        asSchemaFromLinks: () => undefined,
      }),
    });
    const piece = {
      result: { getCell: () => Promise.resolve(resultRoot) },
      input: { getCell: () => Promise.resolve(emptyRoot("input")) },
      getCell: () => emptyRoot("piece"),
    };

    const listing = await listPieceCallables(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-cost",
        space: "home",
      },
      {
        loadPieces: () => Promise.resolve({} as never),
        loadPiece: () => Promise.resolve(piece as never),
      },
    );

    expect(listing.verbs.map((verb) => verb.name).sort()).toEqual([
      "addTopic",
      "undeclared",
    ]);
    expect(listing.verbs.every((verb) => verb.kind === "handler")).toBe(true);
  });

  it("checks the result view and the piece root for a stored signal independently", async () => {
    // Two sources of stored evidence, and neither is allowed to mask the
    // other. `notify` reads as an ordinary number through the declared result
    // type while the piece root stores the stream sentinel at the same name —
    // one cell in a live piece, two objects wherever a surface supplies them
    // apart, which is the case this pins.
    const resultRoot = cell(
      { notify: 3 },
      { type: "object", properties: { notify: { type: "number" } } },
    );
    const piece = {
      result: { getCell: () => Promise.resolve(resultRoot) },
      input: { getCell: () => Promise.resolve(cell(undefined, undefined)) },
      getCell: () => pieceRootCell({ notify: { $stream: true } }),
    };
    const listing = await listPieceCallables(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "fid1:piece-793",
        space: "home",
      },
      {
        loadPieces: () => Promise.resolve({} as never),
        loadPiece: () => Promise.resolve(piece as never),
      },
    );

    // Fails against coalescing the two values before classifying either —
    // `resultValue ?? pieceValue` and `resultValue || pieceValue` both yield
    // `3` here, and `3` carries no stream signal, so the sentinel is never
    // looked at and the listing is empty. It passes only when each stored
    // value is put to classification on its own.
    expect(listing.verbs.map((verb) => verb.name)).toEqual(["notify"]);
    expect(listing.verbs[0].kind).toBe("handler");
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

/** A listing as `listPieceCallables` returns one, built by hand so the
 * rendering is exercised over shapes the lister reaches only against a live
 * piece. */
function listingOf(
  verbs: PieceCallablesListing["verbs"],
  extra: Partial<PieceCallablesListing> = {},
): PieceCallablesListing {
  return { pattern: null, verbs, ...extra };
}

/** A pattern ref carrying the two fields `formatPatternIdentity` reads, so
 * the rendered PATTERN line is a real identity rather than `undefined`. */
const IDENTIFIED_PATTERN_REF = {
  identity: "sha256:feed",
  symbol: "default",
  source: { ref: "sha256:feed" },
} as never;

const ADD_TOPIC_ROW: PieceCallablesListing["verbs"][number] = {
  name: "addTopic",
  kind: "handler",
  on: "result",
  inputSchema: ADD_TOPIC_EVENT,
};

describe("cf piece verbs rendering", () => {
  it("prints no incomplete note for a listing that read its pattern", () => {
    const lines = verbListingLines(listingOf([ADD_TOPIC_ROW]), false);

    // The negative, asserted on the whole output rather than on a flag: this
    // is what fails against a renderer that prints the note unconditionally,
    // which an assertion that only looked for the note when it IS expected
    // would pass.
    expect(lines.join("\n")).not.toContain("the pattern could not be read");
    expect(lines.some((line) => line.startsWith("("))).toBe(false);
    // And the rows really did render, so the absence above is not the absence
    // of all output.
    expect(lines.join("\n")).toContain("addTopic");
  });

  it("prints the incomplete note under the rows when the pattern was unreadable", () => {
    const lines = verbListingLines(
      listingOf([ADD_TOPIC_ROW], { incomplete: "pattern-unavailable" }),
      false,
    );

    // Order is the assertion: a caller reads the note against the rows above
    // it, so a note printed before the table would describe nothing.
    expect(lines[lines.length - 1]).toBe(
      "(the pattern could not be read, so verbs its result type omits are missing; the verbs listed are still callable)",
    );
    expect(lines.slice(0, -1).join("\n")).toContain("addTopic");
  });

  it("prints the incomplete note when no verbs are listed at all", () => {
    // The case the note exists for. Without it `<no callable verbs>` is
    // indistinguishable from a piece that genuinely has none — the failure
    // this whole change is about, at the surface a person actually reads.
    const lines = verbListingLines(
      listingOf([], { incomplete: "pattern-unavailable" }),
      false,
    );

    expect(lines).toEqual([
      "<no callable verbs>",
      "(the pattern could not be read, so verbs its result type omits are missing; the verbs listed are still callable)",
    ]);
  });

  it("keeps the hidden-verb note and the incomplete note apart", () => {
    // Both ways a listing can be short, at once. The hidden count rides the
    // placeholder because it explains why the placeholder says "shown"; the
    // incomplete note is its own line because `--all` cannot recover what it
    // reports. Fails against a renderer that concatenates them, or that drops
    // either when the other is present.
    const lines = verbListingLines(
      listingOf([{ ...ADD_TOPIC_ROW, tier: "wrapper" }], {
        incomplete: "pattern-unavailable",
      }),
      false,
    );

    expect(lines).toEqual([
      "<no callable verbs shown> (1 wrapper, 0 deprecated hidden; --all lists them)",
      "(the pattern could not be read, so verbs its result type omits are missing; the verbs listed are still callable)",
    ]);
  });

  it("prints each row's description beneath its grid line", () => {
    const lines = verbListingLines(
      listingOf([
        {
          ...ADD_TOPIC_ROW,
          description: "File a new topic.\nAppend-only; nothing rewrites one.",
        },
        { name: "clear", kind: "handler", on: "result", inputSchema: true },
      ]),
      false,
    );

    // The grid stays one line per row; the prose rides beneath its own row
    // and nowhere else — a row without a description stays bare.
    const addTopicAt = lines.findIndex((line) => line.startsWith("addTopic"));
    expect(lines[addTopicAt + 1]).toBe("    File a new topic.");
    expect(lines[addTopicAt + 2]).toBe(
      "    Append-only; nothing rewrites one.",
    );
    const clearAt = lines.findIndex((line) => line.startsWith("clear"));
    expect(clearAt).toBe(addTopicAt + 3);
    expect(lines[clearAt + 1]).toBeUndefined();
  });

  it("shows a wrapper row under --all, with no hidden note and the pattern line", () => {
    const lines = verbListingLines(
      listingOf([{ ...ADD_TOPIC_ROW, tier: "wrapper" }], {
        pattern: IDENTIFIED_PATTERN_REF,
      }),
      true,
    );

    // `--all` recovers the hidden row, so its note must go; the pattern
    // identity heads the view whenever the listing carries one.
    expect(lines[0]).toBe("PATTERN cf:module/sha256:feed#default");
    expect(lines.join("\n")).toContain("addTopic");
    expect(lines.join("\n")).toContain("wrapper");
    expect(lines.some((line) => line.startsWith("(1 wrapper"))).toBe(false);
  });

  it("carries incomplete into the --json payload and omits it otherwise", () => {
    // A machine reader has no listing text to read the bound off, so the flag
    // must survive into JSON — and must be absent, not false, when the
    // listing is whole.
    const degraded = verbListingJson(
      listingOf([ADD_TOPIC_ROW], { incomplete: "pattern-unavailable" }),
      false,
    );
    expect(degraded.incomplete).toBe("pattern-unavailable");
    expect(degraded.verbs).toEqual([ADD_TOPIC_ROW]);

    const whole = verbListingJson(listingOf([ADD_TOPIC_ROW]), false);
    expect(Object.hasOwn(whole, "incomplete")).toBe(false);

    // The hidden counts keep their own shape beside it.
    const hidden = verbListingJson(
      listingOf([{ ...ADD_TOPIC_ROW, deprecated: true }]),
      false,
    );
    expect(hidden.hidden).toEqual({ wrapper: 0, deprecated: 1 });
    expect(hidden.verbs).toEqual([]);
  });
});
