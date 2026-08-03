import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/data-model/interface";
import { Identity } from "@commonfabric/identity";
import {
  type Cell,
  ContextualFlowControl,
  type JSONSchema,
  Runtime,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  derivePieceGetValue,
  evaluatePieceGetPredicate,
  mergeMasks,
  parsePieceGetFilter,
  parsePieceGetProjection,
  PieceGetTransformError,
  schemaMayBeArray,
  selectSourceSchema,
} from "../lib/piece-get-transform.ts";

const signer = await Identity.fromPassphrase("cf-piece-get-transform");
const space = signer.did();

function closedFilterVariant(kind: string): JSONSchema {
  return {
    type: "object",
    properties: { kind: { const: kind } },
    required: ["kind"],
    additionalProperties: false,
  };
}

// Path authority is checked before the transform graph uses the source Cell.
// This minimal boundary Cell keeps these tests focused on that pre-graph guard,
// including compound item schemas that the runtime query does not materialize.
function filterGuardSource(
  itemSchema: JSONSchema,
  value: FabricValue,
): Cell<FabricValue[]> {
  const sourceSchema: JSONSchema = { type: "array", items: itemSchema };
  return {
    schema: sourceSchema,
    resolveAsCell() {
      return this;
    },
    asSchema() {
      return this;
    },
    pull() {
      return Promise.resolve([value]);
    },
  } as unknown as Cell<FabricValue[]>;
}

describe("cf piece get transforms", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    const runtimeErrors: Array<{ message: string }> = [];
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "persist",
      errorHandlers: [
        (error) => runtimeErrors.push({ message: error.message }),
      ],
    });
    (runtime as any)[Symbol.for("cf.cli.runtimeErrorLog")] = runtimeErrors;
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("parses and evaluates jq-inspired predicates", () => {
    const parsed = parsePieceGetFilter(
      '.status == "open" and (.score >= 10 or .priority == true)',
    );
    expect(parsed.paths).toEqual([
      ["status"],
      ["score"],
      ["priority"],
    ]);
    expect(evaluatePieceGetPredicate(parsed.predicate, {
      status: "open",
      score: 12,
      priority: false,
    })).toBe(true);
    expect(evaluatePieceGetPredicate(parsed.predicate, {
      status: "closed",
      score: 12,
      priority: true,
    })).toBe(false);
  });

  it("supports bracket paths, negative indices, and not", () => {
    const parsed = parsePieceGetFilter(
      'not .disabled and .["tags"][-1] == "current"',
    );
    expect(evaluatePieceGetPredicate(parsed.predicate, {
      disabled: false,
      tags: ["old", "current"],
    })).toBe(true);
  });

  it("uses jq truthiness for predicate values and missing paths", () => {
    const value = {
      name: "Ada",
      zero: 0,
      empty: "",
      disabled: false,
      nil: null,
      unset: undefined,
    };
    for (
      const source of [
        ".name",
        ".zero",
        ".empty",
        "not .missing",
        "false or true",
        ".disabled == false",
      ]
    ) {
      expect(evaluatePieceGetPredicate(
        parsePieceGetFilter(source).predicate,
        value,
      )).toBe(true);
    }
    for (const source of [".disabled", ".nil", ".unset", ".missing"]) {
      expect(evaluatePieceGetPredicate(
        parsePieceGetFilter(source).predicate,
        value,
      )).toBe(false);
    }
  });

  it("returns null for missing, incompatible, and out-of-range paths", () => {
    const value = {
      nil: null,
      name: "Ada",
      tags: ["first"],
    };
    for (
      const source of [
        ".nil.child",
        ".name.child",
        ".tags.name",
        ".tags[3]",
        ".tags[-3]",
      ]
    ) {
      expect(evaluatePieceGetPredicate(
        parsePieceGetFilter(source).predicate,
        value,
      )).toBe(false);
    }
    expect(evaluatePieceGetPredicate(
      parsePieceGetFilter(".tags[0]").predicate,
      value,
    )).toBe(true);
  });

  it("compares strings, numbers, and structured equality", () => {
    const value = {
      score: 10,
      name: "Grace",
      tags: ["a", "b"],
    };
    for (
      const source of [
        ".score < 11",
        ".score <= 10",
        ".score > 9",
        ".score >= 10",
        '.name < "H"',
        '.tags == .["tags"]',
        ".tags != null",
      ]
    ) {
      expect(evaluatePieceGetPredicate(
        parsePieceGetFilter(source).predicate,
        value,
      )).toBe(true);
    }
    expect(() =>
      evaluatePieceGetPredicate(
        parsePieceGetFilter(".score > true").predicate,
        value,
      )
    ).toThrow("--filter > requires two numbers or two strings");
  });

  it("reports invalid predicate syntax", () => {
    for (
      const source of [
        "",
        "#",
        '"unterminated',
        '"\\x"',
        "(",
        ".name)",
        ".name.",
        ".name[true]",
        '.name["key"',
        "unknown",
      ]
    ) {
      expect(() => parsePieceGetFilter(source)).toThrow(
        PieceGetTransformError,
      );
    }
  });

  it("parses concise, inline, and file projection schemas", async () => {
    const concise = await parsePieceGetProjection("id,author.name");
    expect(concise.kind).toBe("concise");
    expect(concise.schema).toEqual({
      type: "object",
      properties: {
        id: true,
        author: {
          type: "object",
          properties: { name: true },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    });

    const inline = await parsePieceGetProjection(
      '{"type":"object","properties":{"title":{"type":"string"}}}',
    );
    expect(inline.schema).toEqual({
      type: "object",
      properties: { title: { type: "string" } },
      additionalProperties: false,
    });

    const fromFile = await parsePieceGetProjection("@projection.json", {
      readTextFile: () =>
        Promise.resolve(
          '{"type":"array","items":{"type":"object","properties":{"id":true}}}',
        ),
    });
    expect(fromFile.kind).toBe("json");
    expect(fromFile.schema).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { id: true },
        additionalProperties: false,
      },
    });

    const path = await Deno.makeTempFile({ suffix: ".json" });
    try {
      await Deno.writeTextFile(path, '{"type":"object"}');
      expect((await parsePieceGetProjection(`@${path}`)).schema).toEqual({
        type: "object",
        additionalProperties: true,
      });
    } finally {
      await Deno.remove(path);
    }
  });

  it("detects arrays through refs and cyclic schema compositions", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.anyOf = [cyclic, { type: "array" }];
    const rootDefs: JSONSchema = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          anyOf: [
            { $ref: "#/$defs/Leaf" },
            { $ref: "#/$defs/Branch" },
          ],
        },
        Leaf: { type: "object" },
        Branch: { type: "array", items: { $ref: "#/$defs/Leaf" } },
      },
    };

    expect(schemaMayBeArray(false)).toBe(false);
    expect(schemaMayBeArray(cyclic as JSONSchema)).toBe(true);
    expect(schemaMayBeArray(rootDefs)).toBe(true);
    expect(() =>
      schemaMayBeArray({
        $ref: "#/$defs/Missing",
        $defs: {},
      })
    ).toThrow("Could not resolve source schema reference for --schema");
  });

  it("merges predicate reads through aligned array masks", () => {
    expect(mergeMasks(
      {
        type: "object",
        properties: { body: true },
        additionalProperties: false,
      },
      {
        type: "array",
        items: {
          type: "object",
          properties: { author: true },
          additionalProperties: false,
        },
      },
    )).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { body: true, author: true },
        additionalProperties: false,
      },
    });
  });

  it("collapses overlapping concise paths without exposing siblings", async () => {
    for (const source of ["author,author.name", "author.name,author"]) {
      expect((await parsePieceGetProjection(source)).schema).toEqual({
        type: "object",
        properties: { author: true },
        additionalProperties: false,
      });
    }
  });

  it("validates projection schema roots and nested schema objects", async () => {
    await expect(parsePieceGetProjection("")).rejects.toThrow(
      "--schema must not be empty",
    );
    await expect(parsePieceGetProjection("@")).rejects.toThrow(
      "--schema @file requires a file path",
    );
    await expect(parsePieceGetProjection("@missing.json", {
      readTextFile: () => Promise.reject(new Error("gone")),
    })).rejects.toThrow('Could not read --schema file "missing.json": gone');
    await expect(parsePieceGetProjection("@bad.json", {
      readTextFile: () => Promise.resolve("{"),
    })).rejects.toThrow('Invalid JSON in --schema file "bad.json"');
    await expect(parsePieceGetProjection("@array.json", {
      readTextFile: () => Promise.resolve("[]"),
    })).rejects.toThrow("expected a JSON Schema object");
    await expect(parsePieceGetProjection("{")).rejects.toThrow(
      "Invalid JSON passed to --schema",
    );
    await expect(parsePieceGetProjection("false")).rejects.toThrow(
      "false cannot project a value",
    );
    await expect(parsePieceGetProjection(
      '{"type":"object","properties":[]}',
    )).rejects.toThrow('"properties" must be an object');
    await expect(parsePieceGetProjection("a,,b")).rejects.toThrow(
      "expected comma-separated field paths",
    );
    await expect(parsePieceGetProjection("a.0")).rejects.toThrow(
      "Invalid --schema field path",
    );
  });

  it("normalizes identity and additional-property projection schemas", async () => {
    expect((await parsePieceGetProjection('{"type":"object"}')).schema)
      .toEqual({
        type: "object",
        additionalProperties: true,
      });
    expect(
      (await parsePieceGetProjection(
        '{"type":"object","additionalProperties":{"type":"string"}}',
      )).schema,
    ).toEqual({
      type: "object",
      additionalProperties: { type: "string" },
    });
    expect((await parsePieceGetProjection("true")).schema).toBe(true);
  });

  it("does not let caller projection schemas forge CFC metadata", async () => {
    for (const key of ["asCell", "default", "ifc", "scope"]) {
      await expect(parsePieceGetProjection(JSON.stringify({
        type: "object",
        properties: {
          secret: { type: "string", [key]: key === "asCell" ? ["cell"] : {} },
        },
      }))).rejects.toThrow(PieceGetTransformError);
    }
  });

  it("rejects unsupported projection composition keywords", async () => {
    for (
      const key of [
        "$ref",
        "$defs",
        "definitions",
        "allOf",
        "anyOf",
        "oneOf",
        "not",
        "if",
        "then",
        "else",
        "dependentSchemas",
        "contains",
        "patternProperties",
        "prefixItems",
        "propertyNames",
        "contentSchema",
      ]
    ) {
      await expect(parsePieceGetProjection(JSON.stringify({
        type: "object",
        [key]: {},
      }))).rejects.toThrow(`"${key}" is not supported`);
    }
  });

  it("filters and projects arrays through the runtime pattern graph", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "plain-transform-source",
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "number" },
            title: { type: "string" },
            status: { type: "string" },
          },
        },
      },
      tx,
    );
    source.set([
      { id: 1, title: "First", status: "open" },
      { id: 2, title: "Second", status: "closed" },
      { id: 3, title: "Third", status: "open" },
    ]);
    expect((await tx.commit()).ok).toBeDefined();

    const result = await derivePieceGetValue(runtime, space, source, {
      filter: parsePieceGetFilter('.status == "open"'),
      projection: await parsePieceGetProjection("id,title"),
    });

    expect(result).toEqual([
      { id: 1, title: "First" },
      { id: 3, title: "Third" },
    ]);
    expect(
      await derivePieceGetValue(runtime, space, source, {
        projection: await parsePieceGetProjection(
          '{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"title":true}}}',
        ),
      }),
    ).toEqual([
      { title: "First" },
      { title: "Second" },
      { title: "Third" },
    ]);
  });

  it("filters and projects through a linked array slot", async () => {
    const tx = runtime.edit();
    const list = runtime.getCell(
      space,
      "linked-transform-list",
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "number" },
            title: { type: "string" },
          },
        },
      },
      tx,
    );
    list.set([
      { id: 1, title: "First" },
      { id: 2, title: "Second" },
    ]);
    const container = runtime.getCell(
      space,
      "linked-transform-container",
      {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "number" },
                title: { type: "string" },
              },
            },
            asCell: ["cell"],
          },
        },
      },
      tx,
    );
    container.set({ items: list as never });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await derivePieceGetValue(runtime, space, container.key("items"), {
        filter: parsePieceGetFilter(".id == 2"),
        projection: await parsePieceGetProjection("title"),
      }),
    ).toEqual([{ title: "Second" }]);
  });

  it("dereferences nested writable fields for filters and projections", async () => {
    const tx = runtime.edit();
    const author = runtime.getCell(
      space,
      "nested-writable-author",
      {
        type: "object",
        properties: {
          kind: { type: "string" },
          name: { type: "string" },
          privateEmail: { type: "string" },
        },
      },
      tx,
    );
    author.set({
      kind: "agent",
      name: "Sol",
      privateEmail: "sol@example.com",
    });
    const itemSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        createdBy: {
          type: "object",
          properties: {
            kind: { type: "string" },
            name: { type: "string" },
            privateEmail: { type: "string" },
          },
          asCell: ["cell"],
        },
      },
    } as const;
    const source = runtime.getCell(
      space,
      "nested-writable-source",
      { type: "array", items: itemSchema },
      tx,
    );
    source.set([{ title: "T1", createdBy: author as never }]);
    const direct = runtime.getCell(
      space,
      "nested-writable-direct-source",
      itemSchema,
      tx,
    );
    direct.set({ title: "T1", createdBy: author as never });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await derivePieceGetValue(runtime, space, source, {
        projection: await parsePieceGetProjection("title,createdBy.name"),
      }),
    ).toEqual([{ title: "T1", createdBy: { name: "Sol" } }]);
    expect(
      await derivePieceGetValue(runtime, space, source, {
        filter: parsePieceGetFilter('.createdBy.name == "Sol"'),
        projection: await parsePieceGetProjection("title"),
      }),
    ).toEqual([{ title: "T1" }]);
    expect(
      await derivePieceGetValue(runtime, space, direct, {
        projection: await parsePieceGetProjection("title,createdBy.name"),
      }),
    ).toEqual({ title: "T1", createdBy: { name: "Sol" } });
  });

  it("projects a linked object whose target has no schema", async () => {
    const tx = runtime.edit();
    const target = runtime.getCell(
      space,
      "linked-transform-schema-less-target",
      undefined,
      tx,
    );
    target.set({ title: "Visible", hidden: "not returned" });
    const container = runtime.getCell(
      space,
      "linked-transform-schema-less-container",
      {
        type: "object",
        properties: {
          topic: {
            type: "object",
            properties: {
              title: { type: "string" },
              hidden: { type: "string" },
            },
            asCell: ["cell"],
          },
        },
      },
      tx,
    );
    container.set({ topic: target as never });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await derivePieceGetValue(runtime, space, container.key("topic"), {
        projection: await parsePieceGetProjection("title"),
      }),
    ).toEqual({ title: "Visible" });
  });

  it("keeps a declared linked-slot schema narrower than its target", async () => {
    const tx = runtime.edit();
    const target = runtime.getCell(
      space,
      "linked-transform-generation-skew-target",
      {
        type: "object",
        properties: {
          title: { type: "string" },
          secret: { type: "string" },
        },
        additionalProperties: false,
      },
      tx,
    );
    target.set({ title: "Visible", secret: "not declared by the slot" });
    const container = runtime.getCell(
      space,
      "linked-transform-generation-skew-container",
      {
        type: "object",
        properties: {
          topic: {
            type: "object",
            properties: {
              title: {
                type: "string",
                ifc: { confidentiality: ["declared-slot-title"] },
              },
            },
            additionalProperties: false,
            asCell: ["cell"],
          },
        },
        additionalProperties: false,
      },
      tx,
    );
    container.set({ topic: target as never });
    expect((await tx.commit()).ok).toBeDefined();

    const selected = container.key("topic");
    expect(await derivePieceGetValue(runtime, space, selected, {})).toEqual({
      title: "Visible",
    });
    let projectedCell: Cell<unknown> | undefined;
    expect(
      await derivePieceGetValue(runtime, space, selected, {
        projection: await parsePieceGetProjection("title"),
      }, {
        onOutputCell: (cell) => projectedCell = cell,
      }),
    ).toEqual({ title: "Visible" });

    const probeTx = runtime.edit();
    const projectedTitle = projectedCell!.key("title").withTx(probeTx).get();
    const probe = runtime.getCell(
      space,
      "generation-skew-slot-label-probe",
      undefined,
      probeTx,
    );
    probe.set({ projectedTitle });
    probeTx.prepareCfc();
    expect((await probeTx.commit()).ok).toBeDefined();
    expect(derivedConfidentiality(probe.getAsNormalizedFullLink().id))
      .toContain("declared-slot-title");

    await expect(
      derivePieceGetValue(runtime, space, selected, {
        projection: await parsePieceGetProjection("title,secret"),
      }),
    ).rejects.toThrow(
      '--schema path "secret" is not declared by this slot\'s schema',
    );
  });

  it("rejects transform paths excluded by a declared linked-list schema", async () => {
    const listTarget = runtime.getCell(
      space,
      "linked-transform-generation-skew-list-target",
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            secret: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    );
    const listContainer = runtime.getCell(
      space,
      "linked-transform-generation-skew-list-container",
      {
        type: "object",
        properties: {
          topics: {
            type: "array",
            items: {
              type: "object",
              properties: { title: { type: "string" } },
              additionalProperties: false,
            },
            asCell: ["cell"],
          },
        },
        additionalProperties: false,
      },
    );
    const listTx = runtime.edit();
    listTarget.withTx(listTx).set([{
      title: "Visible",
      secret: "not declared by the list slot",
    }]);
    listContainer.withTx(listTx).set({ topics: listTarget as never });
    expect((await listTx.commit()).ok).toBeDefined();

    await expect(
      derivePieceGetValue(
        runtime,
        space,
        listContainer.key("topics"),
        { filter: parsePieceGetFilter(".secret != null") },
      ),
    ).rejects.toThrow(
      '--filter path ".secret" is not declared by this slot\'s schema',
    );
    await expect(
      derivePieceGetValue(
        runtime,
        space,
        listContainer.key("topics"),
        {
          projection: await parsePieceGetProjection(
            '{"type":"array","items":{"type":"object","properties":{"title":true,"secret":true}}}',
          ),
        },
      ),
    ).rejects.toThrow(
      '--schema path "[].secret" is not declared by this slot\'s schema',
    );
  });

  it("formats an excluded numeric filter path", async () => {
    const source = filterGuardSource({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    }, { items: [{}] });

    await expect(
      derivePieceGetValue(runtime, space, source, {
        filter: parsePieceGetFilter(".items[0].secret != null"),
      }),
    ).rejects.toThrow(
      '--filter path ".items[0].secret" is not declared by this slot\'s schema',
    );
  });

  it("rejects excluded filter paths across schema compositions", async () => {
    const cases: Array<{
      schema: JSONSchema;
      value: FabricValue;
    }> = [
      {
        schema: {
          allOf: [closedFilterVariant("a"), closedFilterVariant("a")],
        },
        value: { kind: "a" },
      },
      {
        schema: {
          anyOf: [closedFilterVariant("a"), closedFilterVariant("b")],
        },
        value: { kind: "a" },
      },
      {
        schema: {
          oneOf: [closedFilterVariant("a"), closedFilterVariant("b")],
        },
        value: { kind: "a" },
      },
    ];

    for (const testCase of cases) {
      await expect(
        derivePieceGetValue(
          runtime,
          space,
          filterGuardSource(testCase.schema, testCase.value),
          { filter: parsePieceGetFilter(".secret != null") },
        ),
      ).rejects.toThrow(
        '--filter path ".secret" is not declared by this slot\'s schema',
      );
    }
  });

  it("keeps a declared link scope cap during transforms", async () => {
    const tx = runtime.edit();
    const target = runtime.getCell(
      space,
      "linked-transform-capped-target",
      { type: "object", properties: { field: { type: "string" } } },
      tx,
      "session",
    );
    target.set({ field: "session-only" });
    const container = runtime.getCell(
      space,
      "linked-transform-capped-container",
      {
        type: "object",
        properties: {
          handle: {
            type: "object",
            properties: { field: { type: "string" } },
            asCell: [{ kind: "cell", scope: "space" }],
          },
        },
      },
      tx,
    );
    const uncappedContainer = runtime.getCell(
      space,
      "linked-transform-uncapped-container",
      {
        type: "object",
        properties: {
          handle: {
            type: "object",
            properties: { field: { type: "string" } },
            asCell: ["cell"],
          },
        },
      },
      tx,
    );
    container.set({ handle: target as never });
    uncappedContainer.set({ handle: target as never });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await derivePieceGetValue(runtime, space, container.key("handle"), {
        projection: await parsePieceGetProjection("field"),
      }),
    ).toBeUndefined();
    expect(
      await derivePieceGetValue(
        runtime,
        space,
        uncappedContainer.key("handle"),
        { projection: await parsePieceGetProjection("field") },
      ),
    ).toEqual({ field: "session-only" });
  });

  it("materializes a projection instead of aliasing its broader source", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "non-aliasing-projection-source",
      {
        type: "object",
        properties: {
          title: { type: "string" },
          hidden: { type: "string" },
        },
      },
      tx,
    );
    source.set({ title: "Visible", hidden: "not returned" });
    expect((await tx.commit()).ok).toBeDefined();

    let outputCell: Cell<unknown> | undefined;
    expect(
      await derivePieceGetValue(runtime, space, source, {
        projection: await parsePieceGetProjection("title"),
      }, {
        onOutputCell: (cell) => outputCell = cell,
      }),
    ).toEqual({ title: "Visible" });
    expect(outputCell!.get()).toEqual({ title: "Visible" });
    expect(outputCell!.resolveAsCell().getAsNormalizedFullLink().id).not.toBe(
      source.getAsNormalizedFullLink().id,
    );
  });

  it("filters and projects a writable array value", async () => {
    const tx = runtime.edit();
    const first = runtime.getCell(
      space,
      "writable-transform-first",
      {
        type: "object",
        properties: {
          id: { type: "number" },
          title: { type: "string" },
        },
      },
      tx,
    );
    first.set({ id: 1, title: "First" });
    const second = runtime.getCell(
      space,
      "writable-transform-second",
      {
        type: "object",
        properties: {
          id: { type: "number" },
          title: { type: "string" },
        },
      },
      tx,
    );
    second.set({ id: 2, title: "Second" });
    const source = runtime.getCell(
      space,
      "writable-transform-list",
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "number" },
            title: { type: "string" },
          },
          asCell: ["cell"],
        },
        asCell: ["cell"],
      },
      tx,
    );
    source.set([
      first,
      second,
    ]);
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await derivePieceGetValue(runtime, space, source, {
        filter: parsePieceGetFilter(".id == 2"),
        projection: await parsePieceGetProjection("title"),
      }),
    ).toEqual([{ title: "Second" }]);
  });

  it("does not leak nested siblings from overlapping concise paths", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "overlap-projection-source",
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            author: {
              type: "object",
              properties: {
                name: { type: "string" },
                privateEmail: { type: "string" },
              },
            },
            ignored: { type: "string" },
          },
        },
      },
      tx,
    );
    source.set([{
      author: { name: "Ada", privateEmail: "ada@example.com" },
      ignored: "hidden",
    }]);
    expect((await tx.commit()).ok).toBeDefined();

    const result = await derivePieceGetValue(runtime, space, source, {
      projection: await parsePieceGetProjection(
        "author.name,author.name.first",
      ),
    });

    expect(result).toEqual([{ author: { name: "Ada" } }]);
  });

  it("supports direct projection and identity object schemas", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "object-projection-source",
      {
        type: "object",
        properties: {
          id: { type: "number" },
          title: { type: "string" },
          subtitle: { type: ["string", "null"] },
        },
        required: ["id", "title", "subtitle"],
      },
      tx,
    );
    source.set({ id: 1, title: "Visible", subtitle: null });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await derivePieceGetValue(runtime, space, source, {
        projection: await parsePieceGetProjection("id"),
      }),
    ).toEqual({ id: 1 });
    expect(
      await derivePieceGetValue(runtime, space, source, {
        projection: await parsePieceGetProjection("missing"),
      }),
    ).toEqual({});
    expect(
      await derivePieceGetValue(runtime, space, source, {
        projection: await parsePieceGetProjection(JSON.stringify({
          type: "object",
          properties: {
            subtitle: { type: ["string", "null"] },
          },
          additionalProperties: false,
        })),
      }),
    ).toEqual({ subtitle: null });
    expect(
      await derivePieceGetValue(runtime, space, source, {
        projection: await parsePieceGetProjection('{"type":"object"}'),
      }),
    ).toEqual({ id: 1, title: "Visible", subtitle: null });
    expect(await derivePieceGetValue(runtime, space, source, {})).toEqual({
      id: 1,
      title: "Visible",
      subtitle: null,
    });
  });

  it("projects nested arrays with explicit item schemas", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "nested-array-projection-source",
      {
        type: "object",
        properties: {
          comments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                body: { type: "string" },
                privateNote: { type: "string" },
              },
            },
          },
        },
      },
      tx,
    );
    source.set({
      comments: [{ body: "Hello", privateNote: "not returned" }],
    });
    expect((await tx.commit()).ok).toBeDefined();

    const projection = {
      type: "object",
      properties: {
        comments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              body: true,
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    };
    expect(
      await derivePieceGetValue(runtime, space, source, {
        projection: await parsePieceGetProjection(JSON.stringify(projection)),
      }),
    ).toEqual({ comments: [{ body: "Hello" }] });
  });

  it("preserves nullable array items through concise projections", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "nullable-concise-projection-source",
      {
        type: "array",
        items: {
          type: ["object", "null"],
          properties: {
            name: { type: "string" },
            secret: { type: "string" },
          },
        },
      },
      tx,
    );
    source.set([{ name: "a", secret: "hidden" }, null]);
    expect((await tx.commit()).ok).toBeDefined();

    expect(await derivePieceGetValue(runtime, space, source, {})).toEqual([
      { name: "a", secret: "hidden" },
      null,
    ]);
    expect(
      await derivePieceGetValue(runtime, space, source, {
        filter: parsePieceGetFilter('.name == "a"'),
      }),
    ).toEqual([{ name: "a", secret: "hidden" }]);
    expect(
      await derivePieceGetValue(runtime, space, source, {
        projection: await parsePieceGetProjection("name"),
      }),
    ).toEqual([{ name: "a" }, null]);
    expect(
      await derivePieceGetValue(runtime, space, source, {
        projection: await parsePieceGetProjection(JSON.stringify({
          type: "array",
          items: {
            type: ["object", "null"],
            properties: { name: true },
            additionalProperties: false,
          },
        })),
      }),
    ).toEqual([{ name: "a" }, null]);
  });

  it("projects concise paths through nested and repeated arrays", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "nested-concise-array-projection-source",
      {
        type: "object",
        properties: {
          comments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                body: { type: "string" },
                privateNote: { type: "string" },
                replies: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      body: { type: "string" },
                      privateNote: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      tx,
    );
    source.set({
      comments: [{
        body: "Top level",
        privateNote: "hidden",
        replies: [{ body: "Nested", privateNote: "also hidden" }],
      }],
    });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await derivePieceGetValue(runtime, space, source, {
        projection: await parsePieceGetProjection(
          "comments.body,comments.replies.body",
        ),
      }),
    ).toEqual({
      comments: [{
        body: "Top level",
        replies: [{ body: "Nested" }],
      }],
    });
  });

  it("preserves nullable property unions independently of their parent", async () => {
    for (const additionalProperties of [false, true]) {
      const tx = runtime.edit();
      const source = runtime.getCell(
        space,
        `nullable-property-${additionalProperties}`,
        {
          type: "object",
          properties: {
            profiles: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  profile: {
                    type: ["object", "null"],
                    properties: {
                      name: { type: "string" },
                      secret: { type: "string" },
                    },
                  },
                },
              },
            },
          },
          additionalProperties,
        },
        tx,
      );
      source.set({
        profiles: [
          { profile: { name: "Ada", secret: "hidden" } },
          { profile: null },
        ],
      });
      expect((await tx.commit()).ok).toBeDefined();

      expect(
        await derivePieceGetValue(runtime, space, source, {
          projection: await parsePieceGetProjection("profiles.profile.name"),
        }),
      ).toEqual({
        profiles: [{ profile: { name: "Ada" } }, { profile: null }],
      });
    }
  });

  it("preserves anyOf nullability in concise array projections", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "any-of-nullable-concise-source",
      {
        type: "array",
        items: {
          anyOf: [
            {
              type: "object",
              properties: {
                name: { type: "string" },
                secret: { type: "string" },
              },
            },
            { type: "null" },
          ],
        },
      },
      tx,
    );
    source.set([{ name: "Ada", secret: "hidden" }, null]);
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await derivePieceGetValue(runtime, space, source, {
        projection: await parsePieceGetProjection("name"),
      }),
    ).toEqual([{ name: "Ada" }, null]);
  });

  it("projects concise fields through allOf source schemas", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "all-of-concise-source",
      {
        type: "array",
        items: {
          allOf: [
            {
              type: "object",
              properties: { name: { type: "string" } },
            },
            {
              type: "object",
              properties: { secret: { type: "string" } },
            },
          ],
        },
      },
      tx,
    );
    source.set([{ name: "Ada", secret: "hidden" }]);
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await derivePieceGetValue(runtime, space, source, {
        projection: await parsePieceGetProjection("name"),
      }),
    ).toEqual([{ name: "Ada" }]);
  });

  it("projects concise paths through a linked nested array", async () => {
    const tx = runtime.edit();
    const comments = runtime.getCell(
      space,
      "linked-nested-comments",
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            body: { type: "string" },
            privateNote: { type: "string" },
          },
        },
      },
      tx,
    );
    comments.set([{ body: "Visible", privateNote: "hidden" }]);
    const source = runtime.getCell(
      space,
      "linked-nested-array-source",
      {
        type: "object",
        properties: {
          comments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                body: { type: "string" },
                privateNote: { type: "string" },
              },
            },
            asCell: ["cell"],
          },
        },
      },
      tx,
    );
    source.set({ comments: comments as never });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await derivePieceGetValue(runtime, space, source, {
        projection: await parsePieceGetProjection("comments.body"),
      }),
    ).toEqual({ comments: [{ body: "Visible" }] });
  });

  it("projects concise array paths through source schema references", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "referenced-nested-array-source",
      {
        type: "object",
        properties: {
          comments: {
            $ref: "#/$defs/Comments",
          },
        },
        $defs: {
          Comments: {
            anyOf: [
              { $ref: "#/$defs/CommentList" },
              { type: "null" },
            ],
          },
          CommentList: {
            type: "array",
            items: { $ref: "#/$defs/Comment" },
          },
          Comment: {
            type: "object",
            properties: {
              body: { type: "string" },
              privateNote: { type: "string" },
            },
          },
        },
      },
      tx,
    );
    source.set({
      comments: [{ body: "Visible", privateNote: "hidden" }],
    });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await derivePieceGetValue(runtime, space, source, {
        projection: await parsePieceGetProjection("comments.body"),
      }),
    ).toEqual({ comments: [{ body: "Visible" }] });
  });

  it("does not leak siblings when a nested array schema is ambiguous", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "ambiguous-nested-array-source",
      {
        type: "object",
        properties: { comments: true },
      },
      tx,
    );
    source.set({
      comments: [{ body: "Visible", privateNote: "hidden" }],
    });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await derivePieceGetValue(runtime, space, source, {
        projection: await parsePieceGetProjection("comments.body"),
      }),
    ).toEqual({ comments: [{ body: "Visible" }] });
  });

  it("does not leak siblings when a nested value may be an array or object", async () => {
    const variants: JSONSchema[] = [
      {
        anyOf: [
          {
            type: "array",
            items: {
              type: "object",
              properties: {
                body: { type: "string" },
                privateNote: { type: "string" },
              },
            },
          },
          {
            type: "object",
            properties: {
              body: { type: "string" },
              privateNote: { type: "string" },
            },
          },
        ],
      },
      {
        type: ["array", "object"],
        items: {
          type: "object",
          properties: {
            body: { type: "string" },
            privateNote: { type: "string" },
          },
        },
        properties: {
          body: { type: "string" },
          privateNote: { type: "string" },
        },
      },
    ];

    for (const [index, entrySchema] of variants.entries()) {
      const tx = runtime.edit();
      const source = runtime.getCell(
        space,
        `array-object-union-${index}`,
        {
          type: "object",
          properties: { entry: entrySchema },
        },
        tx,
      );
      source.set({
        entry: { body: "Visible", privateNote: "hidden" },
      });
      expect((await tx.commit()).ok).toBeDefined();

      expect(
        await derivePieceGetValue(runtime, space, source, {
          projection: await parsePieceGetProjection("entry.body"),
        }),
      ).toEqual({ entry: { body: "Visible" } });
    }
  });

  it("keeps anyOf and oneOf constraints distinct on source reads", () => {
    const source: JSONSchema = {
      anyOf: [{ type: "string" }, { type: "number" }],
      oneOf: [{ const: "a" }, { const: "b" }],
      allOf: [{ type: "string" }],
    };
    const mask = {
      type: "object" as const,
      properties: { body: true as const },
      additionalProperties: false as const,
    };
    const cfc = new ContextualFlowControl();
    expect(selectSourceSchema(cfc, source, mask)).toBe(source);
    expect(
      selectSourceSchema(cfc, source, mask, "projected-output"),
    ).toEqual({
      anyOf: source.anyOf,
      allOf: [
        { type: "string" },
        { anyOf: source.oneOf },
      ],
    });

    expect(
      selectSourceSchema(cfc, {
        type: "object",
        properties: { visible: { type: "string" } },
        additionalProperties: false,
      }, {
        type: "object",
        properties: { excluded: true },
        additionalProperties: false,
      }),
    ).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("handles schema-less filters and identity projection schemas", async () => {
    const tx = runtime.edit();
    const schemaLess = runtime.getCell(
      space,
      "schema-less-filter-source",
      undefined,
      tx,
    );
    schemaLess.set([1, 2]);
    const nestedArrays = runtime.getCell(
      space,
      "nested-array-filter-source",
      {
        type: "array",
        items: { type: "array", items: { type: "number" } },
      },
      tx,
    );
    nestedArrays.set([[1], []]);
    const scalar = runtime.getCell(
      space,
      "scalar-projection-source",
      { type: "string" },
      tx,
    );
    scalar.set("visible");
    const permissiveArray = runtime.getCell(
      space,
      "permissive-array-projection-source",
      {},
      tx,
    );
    permissiveArray.set([{ id: 1, hidden: true }]);
    const composedObject = runtime.getCell(
      space,
      "composed-object-projection-source",
      {
        anyOf: [{
          type: "object",
          properties: { id: { type: "number" } },
        }],
      },
      tx,
    );
    composedObject.set({ id: 2 });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await derivePieceGetValue(runtime, space, schemaLess, {
        filter: parsePieceGetFilter("true"),
      }),
    ).toEqual([1, 2]);
    expect(
      await derivePieceGetValue(runtime, space, schemaLess, {
        filter: parsePieceGetFilter("."),
      }),
    ).toEqual([1, 2]);
    expect(
      await derivePieceGetValue(runtime, space, nestedArrays, {
        filter: parsePieceGetFilter(".[0]"),
      }),
    ).toEqual([[1]]);
    expect(
      await derivePieceGetValue(runtime, space, nestedArrays, {
        filter: parsePieceGetFilter(".length"),
        projection: await parsePieceGetProjection(
          '{"type":"array","items":{"type":"array","items":true}}',
        ),
      }),
    ).toEqual([]);
    expect(
      await derivePieceGetValue(runtime, space, schemaLess, {
        projection: await parsePieceGetProjection("true"),
      }),
    ).toEqual([1, 2]);
    expect(
      await derivePieceGetValue(runtime, space, schemaLess, {
        projection: await parsePieceGetProjection('{"type":"array"}'),
      }),
    ).toEqual([1, 2]);
    expect(
      await derivePieceGetValue(runtime, space, schemaLess, {
        projection: await parsePieceGetProjection(
          '{"type":["array","null"],"items":true}',
        ),
      }),
    ).toEqual([1, 2]);
    expect(
      await derivePieceGetValue(runtime, space, scalar, {
        projection: await parsePieceGetProjection('{"type":"string"}'),
      }),
    ).toBe("visible");
    expect(
      await derivePieceGetValue(runtime, space, permissiveArray, {
        projection: await parsePieceGetProjection("id"),
      }),
    ).toEqual([{ id: 1 }]);
    expect(
      await derivePieceGetValue(runtime, space, composedObject, {
        projection: await parsePieceGetProjection("id"),
      }),
    ).toEqual({ id: 2 });
  });

  it("supports an explicitly closed object projection", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "closed-object-projection-source",
      {
        type: "object",
        properties: { hidden: { type: "string" } },
      },
      tx,
    );
    source.set({ hidden: "not returned" });
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await derivePieceGetValue(runtime, space, source, {
        projection: await parsePieceGetProjection(
          '{"type":"object","additionalProperties":false}',
        ),
      }),
    ).toEqual({});
  });

  it("rejects JSON projection roots that mismatch the selected value", async () => {
    const tx = runtime.edit();
    const arraySource = runtime.getCell(
      space,
      "array-schema-mismatch-source",
      { type: "array", items: { type: "object" } },
      tx,
    );
    arraySource.set([{ id: 1 }]);
    const objectSource = runtime.getCell(
      space,
      "object-schema-mismatch-source",
      { type: "object" },
      tx,
    );
    objectSource.set({ id: 1 });
    expect((await tx.commit()).ok).toBeDefined();

    await expect(derivePieceGetValue(runtime, space, arraySource, {
      projection: await parsePieceGetProjection('{"type":"object"}'),
    })).rejects.toThrow("must describe the returned array");
    await expect(derivePieceGetValue(runtime, space, objectSource, {
      projection: await parsePieceGetProjection(
        '{"type":"array","items":true}',
      ),
    })).rejects.toThrow(
      "can only be applied to an array value",
    );
  });

  it("treats a missing filter path as a non-match", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "missing-filter-path-source",
      {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "number" } },
        },
      },
      tx,
    );
    source.set([{ id: 1 }, { id: 2 }]);
    expect((await tx.commit()).ok).toBeDefined();

    expect(
      await derivePieceGetValue(runtime, space, source, {
        filter: parsePieceGetFilter(".missing"),
      }),
    ).toEqual([]);
  });

  it("rejects --filter for non-array sources", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "object-filter-source",
      { type: "object", properties: { id: { type: "number" } } },
      tx,
    );
    source.set({ id: 1 });
    expect((await tx.commit()).ok).toBeDefined();

    await expect(derivePieceGetValue(runtime, space, source, {
      filter: parsePieceGetFilter(".id == 1"),
    })).rejects.toThrow("--filter can only be applied to an array");
  });

  it("reports runtime predicate failures as transform errors", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      space,
      "predicate-runtime-error-source",
      {
        type: "array",
        items: {
          type: "object",
          properties: { score: { type: "boolean" } },
        },
      },
      tx,
    );
    source.set([{ score: true }]);
    expect((await tx.commit()).ok).toBeDefined();

    await expect(derivePieceGetValue(runtime, space, source, {
      filter: parsePieceGetFilter(".score > 1"),
    })).rejects.toThrow("Could not apply piece get transform");
  });

  it("reports transform transaction commit failures", async () => {
    const setup = runtime.edit();
    const source = runtime.getCell(
      space,
      "transform-commit-error-source",
      {
        type: "object",
        properties: { id: { type: "number" } },
      },
      setup,
    );
    source.set({ id: 1 });
    expect((await setup.commit()).ok).toBeDefined();

    const originalEdit = runtime.edit.bind(runtime);
    (runtime as any).edit = () => {
      const tx = originalEdit();
      (tx as any).commit = () =>
        Promise.resolve({ error: "forced commit failure" });
      return tx;
    };
    try {
      await expect(derivePieceGetValue(runtime, space, source, {
        projection: await parsePieceGetProjection("id"),
      })).rejects.toThrow(
        "Could not apply piece get transform: forced commit failure",
      );
    } finally {
      (runtime as any).edit = originalEdit;
    }
  });

  it("carries predicate labels on filtered membership like a pattern", async () => {
    await seedLabeledDoc(runtime, "filter-element-a", {
      id: 1,
      status: "open",
    }, "alice-secret");
    await seedLabeledDoc(runtime, "filter-element-b", {
      id: 2,
      status: "closed",
    }, "bob-secret");

    const setup = runtime.edit();
    const elementA = runtime.getCell(
      space,
      "filter-element-a",
      undefined,
      setup,
    );
    const elementB = runtime.getCell(
      space,
      "filter-element-b",
      undefined,
      setup,
    );
    const source = runtime.getCell(
      space,
      "labeled-filter-source",
      { type: "array", items: { asCell: ["cell"] } },
      setup,
    );
    source.set([elementA, elementB]);
    expect((await setup.commit()).ok).toBeDefined();
    const sourceRead = runtime.getCell(
      space,
      "labeled-filter-source",
      { type: "array", items: { asCell: ["cell"] } },
    );

    let outputCell: Cell<unknown> | undefined;
    const result = await derivePieceGetValue(runtime, space, sourceRead, {
      filter: parsePieceGetFilter('.status == "open"'),
    }, {
      onOutputCell: (cell) => outputCell = cell,
    });
    expect(result).toEqual([{ id: 1, status: "open" }]);

    const probeTx = runtime.edit();
    const kept = outputCell!.withTx(probeTx).get() as unknown[];
    const probe = runtime.getCell(
      space,
      "filter-membership-probe",
      undefined,
      probeTx,
    );
    probe.set({ count: kept.length });
    probeTx.prepareCfc();
    expect((await probeTx.commit()).ok).toBeDefined();

    const labels = derivedConfidentiality(
      probe.getAsNormalizedFullLink().id,
    );
    expect(labels).toContain("alice-secret");
    expect(labels).toContain("bob-secret");
  });

  it("derives projected field labels from source CFC metadata", async () => {
    const setup = runtime.edit();
    const source = runtime.getCell(
      space,
      "static-label-projection-source",
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: {
              type: "number",
              ifc: { confidentiality: ["source-secret"] },
            },
            ignored: { type: "string" },
          },
        },
      },
      setup,
    );
    source.set([{ id: 7, ignored: "not returned" }]);
    expect((await setup.commit()).ok).toBeDefined();

    let outputCell: Cell<unknown> | undefined;
    const result = await derivePieceGetValue(runtime, space, source, {
      projection: await parsePieceGetProjection("id"),
    }, {
      onOutputCell: (cell) => outputCell = cell,
    });
    expect(result).toEqual([{ id: 7 }]);

    const probeTx = runtime.edit();
    const projectedId = outputCell!.key(0).key("id").withTx(
      probeTx,
    ).get();
    const probe = runtime.getCell(
      space,
      "projection-label-probe",
      undefined,
      probeTx,
    );
    probe.set({ projectedId });
    probeTx.prepareCfc();
    expect((await probeTx.commit()).ok).toBeDefined();

    expect(derivedConfidentiality(
      probe.getAsNormalizedFullLink().id,
    )).toContain("source-secret");
  });

  async function seedLabeledDoc(
    targetRuntime: Runtime,
    cause: string,
    value: FabricValue,
    atom: string,
  ): Promise<void> {
    const seed = targetRuntime.edit();
    const cell = targetRuntime.getCell(space, cause, undefined, seed);
    const id = cell.getAsNormalizedFullLink().id;
    seed.writeOrThrow({
      space,
      scope: "space",
      id,
      path: [],
    }, {
      value,
      cfc: {
        version: 1,
        schemaHash: "seed-schema",
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            label: { confidentiality: [atom] },
          }],
        },
      },
    });
    expect((await seed.commit()).ok).toBeDefined();
  }

  function derivedConfidentiality(id: string): string[] {
    type StoredEntry = {
      origin?: string;
      label: { confidentiality?: string[] };
    };
    const replica = storageManager.open(space).replica as unknown as {
      getDocument(
        id: string,
      ): { cfc?: { labelMap?: { entries: StoredEntry[] } } } | undefined;
    };
    return replica.getDocument(id)?.cfc?.labelMap?.entries
      ?.filter((entry) => entry.origin === "derived")
      .flatMap((entry) => entry.label.confidentiality ?? []) ?? [];
  }
});
