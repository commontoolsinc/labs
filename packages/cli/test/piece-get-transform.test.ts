import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/data-model/interface";
import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  derivePieceGetValue,
  evaluatePieceGetPredicate,
  parsePieceGetFilter,
  parsePieceGetProjection,
  PieceGetTransformError,
} from "../lib/piece-get-transform.ts";

const signer = await Identity.fromPassphrase("cf-piece-get-transform");
const space = signer.did();

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
        },
        required: ["id", "title"],
      },
      tx,
    );
    source.set({ id: 1, title: "Visible" });
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
        projection: await parsePieceGetProjection('{"type":"object"}'),
      }),
    ).toEqual({ id: 1, title: "Visible" });
    expect(await derivePieceGetValue(runtime, space, source, {})).toEqual({
      id: 1,
      title: "Visible",
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
