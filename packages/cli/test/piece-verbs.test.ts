import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import { listPieceCallables } from "../lib/piece.ts";

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

    // "hiddenPing" defeats ordinary result/input detection (plain object
    // value/schema) but the unmodified piece cell still identifies it as a
    // stream, so the legacy fallback must include it. "topicCount" reproduces
    // a real data field: the forced view below calls every name a stream, but
    // the unmodified cell does not. "\u00e9dit" pins byte ordering.
    const pieceRootValue = {
      hiddenPing: {},
      topicCount: 3,
      "\u00e9dit": { $stream: true },
    };
    const piece = {
      result: { getCell: () => Promise.resolve(resultRoot) },
      input: { getCell: () => Promise.resolve(inputRoot) },
      getPatternRef: () => Promise.resolve(TEST_PATTERN_REF),
      getCell: () => ({
        get: () => pieceRootValue,
        key: (name: string) => ({
          isStream: () => name === "hiddenPing" || name === "\u00e9dit",
        }),
        asSchema: (_s: unknown) => ({
          // This is true for every name because the caller imposed a stream
          // schema. It is a dispatch view, not evidence that a handler exists.
          key: (_name: string) => ({ isStream: () => true }),
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
        loadManager: () => Promise.resolve(manager as never),
        loadPiece: () => Promise.resolve(piece as never),
      },
    );

    // The deployed pattern's identity rides the listing — the skew detector.
    expect(listing.pattern).toEqual(TEST_PATTERN_REF);
    const verbs = listing.verbs;
    expect(verbs.map((v) => v.name)).toEqual([
      "addTopic",
      "hiddenPing",
      "search",
      "setup",
      "\u00e9dit",
    ]);

    const [addTopic, hiddenPing, search, setup, accented] = verbs;
    // Fallback-resolved handlers are listed as handlers on the result cell,
    // exactly as tryResolvePieceHandler dispatches them.
    expect(hiddenPing.kind).toBe("handler");
    expect(hiddenPing.on).toBe("result");
    expect(accented.kind).toBe("handler");
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
        loadManager: () => Promise.resolve({ getSpace: () => "home" } as never),
        loadPiece: () => Promise.resolve(piece as never),
      },
    );
    // No getPatternRef on the double: identity degrades to null, honestly.
    expect(listing.pattern).toBeNull();
    expect(listing.verbs).toEqual([]);
  });
});
