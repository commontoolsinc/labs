import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import { listPieceCallables } from "../lib/piece.ts";

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

    const piece = {
      result: { getCell: () => Promise.resolve(resultRoot) },
      input: { getCell: () => Promise.resolve(inputRoot) },
    };
    const manager = { getSpace: () => "home" };

    const verbs = await listPieceCallables(
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

    expect(verbs.map((v) => v.name)).toEqual(["addTopic", "search", "setup"]);

    const [addTopic, search, setup] = verbs;
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
    const verbs = await listPieceCallables(
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
    expect(verbs).toEqual([]);
  });
});
