import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchema } from "@commonfabric/api";
import {
  anySchema,
  ARRAY_SUBSCHEMA_KEYS,
  findSchema,
  forEachSubschema,
  RECORD_SUBSCHEMA_KEYS,
  SINGLE_SUBSCHEMA_KEYS,
  type SchemaNode,
  type SubschemaKeyword,
  walkSchema,
} from "../src/schema-walk.ts";

interface Edge {
  schema: JSONSchema;
  keyword: SubschemaKeyword;
  key?: string;
  index?: number;
}

const edgesOf = (
  root: JSONSchema,
  opts?: Parameters<typeof forEachSubschema>[2],
): Edge[] => {
  const edges: Edge[] = [];
  forEachSubschema(root, (schema, keyword, key, index) => {
    edges.push({ schema, keyword, key, index });
  }, opts);
  return edges;
};

const collect = (
  root: JSONSchema,
  opts?: Parameters<typeof walkSchema>[2],
): SchemaNode[] => {
  const nodes: SchemaNode[] = [];
  walkSchema(root, (node) => {
    nodes.push(node);
  }, opts);
  return nodes;
};

const pathKeys = (root: JSONSchema, opts?: Parameters<typeof walkSchema>[2]) =>
  collect(root, opts).map((n) => n.path.join("/"));

describe("forEachSubschema", () => {
  it("visits immediate children across all keyword shapes", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      additionalProperties: { type: "boolean" },
      items: { type: "null" },
      prefixItems: [{ type: "string" }, { type: "number" }],
      allOf: [{ type: "object" }],
      not: { type: "array" },
    };
    const edges = edgesOf(schema);
    // properties(2) + additionalProperties(1) + items(1) + prefixItems(2)
    // + allOf(1) + not(1) = 8
    expect(edges.length).toBe(8);
    const byKeyword = new Map<string, number>();
    for (const e of edges) {
      byKeyword.set(e.keyword, (byKeyword.get(e.keyword) ?? 0) + 1);
    }
    expect(byKeyword.get("properties")).toBe(2);
    expect(byKeyword.get("prefixItems")).toBe(2);
    expect(byKeyword.get("items")).toBe(1);
    expect(byKeyword.get("not")).toBe(1);
  });

  it("carries key for record edges and index for array edges", () => {
    const schema: JSONSchema = {
      properties: { name: { type: "string" } },
      prefixItems: [{ type: "string" }, { type: "number" }],
    };
    const edges = edgesOf(schema);
    const prop = edges.find((e) => e.keyword === "properties");
    expect(prop?.key).toBe("name");
    const prefix1 = edges.find((e) =>
      e.keyword === "prefixItems" && e.index === 1
    );
    expect(prefix1?.schema).toEqual({ type: "number" });
  });

  it("skips $defs unless includeDefs is set", () => {
    const schema: JSONSchema = {
      $defs: { Foo: { type: "string" } },
      properties: { a: { $ref: "#/$defs/Foo" } },
    };
    expect(edgesOf(schema).some((e) => e.keyword === "$defs")).toBe(false);
    expect(
      edgesOf(schema, { includeDefs: true }).some((e) => e.keyword === "$defs"),
    ).toBe(true);
  });

  it("visits nothing for boolean or empty schemas", () => {
    expect(edgesOf(true).length).toBe(0);
    expect(edgesOf(false).length).toBe(0);
    expect(edgesOf({ type: "string" }).length).toBe(0);
  });

  it("stops early and reports it when a visit returns true", () => {
    const schema: JSONSchema = {
      properties: { a: { type: "string" }, b: { type: "number" } },
      items: { type: "null" },
    };
    const seen: JSONSchema[] = [];
    const stopped = forEachSubschema(schema, (child) => {
      seen.push(child);
      return true; // stop after the very first child
    });
    expect(stopped).toBe(true);
    expect(seen.length).toBe(1);
    // A visit-all returns false.
    expect(forEachSubschema(schema, () => {})).toBe(false);
  });

  it("covers every documented keyword constant", () => {
    for (const keyword of SINGLE_SUBSCHEMA_KEYS) {
      const edges = edgesOf({ [keyword]: { type: "string" } });
      expect(edges.map((e) => e.keyword)).toContain(keyword);
    }
    for (const keyword of ARRAY_SUBSCHEMA_KEYS) {
      const edges = edgesOf({ [keyword]: [{ type: "string" }] });
      expect(edges.map((e) => e.keyword)).toContain(keyword);
    }
    for (const keyword of RECORD_SUBSCHEMA_KEYS) {
      const edges = edgesOf({ [keyword]: { x: { type: "string" } } });
      expect(edges.map((e) => e.keyword)).toContain(keyword);
    }
  });
});

describe("walkSchema", () => {
  it("visits the root then descends depth-first", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: { id: { type: "string" } },
        },
      },
    };
    const paths = pathKeys(schema);
    expect(paths).toEqual([
      "",
      "properties/user",
      "properties/user/properties/id",
    ]);
  });

  it("builds keyword-segmented structural paths through arrays and applicators", () => {
    const schema: JSONSchema = {
      allOf: [
        { properties: { id: { type: "string" } } },
      ],
      prefixItems: [{ type: "string" }, { items: { type: "number" } }],
    };
    const paths = pathKeys(schema);
    expect(paths).toContain("allOf/0/properties/id");
    expect(paths).toContain("prefixItems/1/items");
  });

  it("descends into prefixItems (the historically-skipped keyword)", () => {
    const schema: JSONSchema = {
      type: "array",
      prefixItems: [
        { type: "string", ifc: { integrity: ["x"] } },
      ],
    };
    const hit = findSchema(
      schema,
      (n) => typeof n.schema === "object" && n.schema.ifc !== undefined,
    );
    expect(hit?.path.join("/")).toBe("prefixItems/0");
  });

  it("skip prunes a subtree but continues siblings", () => {
    const schema: JSONSchema = {
      properties: {
        keep: { properties: { deep: { type: "string" } } },
        prune: { properties: { hidden: { type: "string" } } },
      },
    };
    const visited: string[] = [];
    walkSchema(schema, (node) => {
      visited.push(node.path.join("/"));
      if (node.key === "prune") return "skip";
    });
    expect(visited).toContain("properties/keep/properties/deep");
    expect(visited).toContain("properties/prune");
    expect(visited).not.toContain("properties/prune/properties/hidden");
  });

  it("stop aborts the whole walk", () => {
    const schema: JSONSchema = {
      properties: {
        a: { properties: { deep: { type: "string" } } },
        b: { type: "string" },
      },
    };
    const visited: string[] = [];
    walkSchema(schema, (node) => {
      visited.push(node.path.join("/"));
      if (node.key === "a") return "stop";
    });
    expect(visited).toEqual(["", "properties/a"]);
  });

  it("exposes parent and edge discriminants", () => {
    const schema: JSONSchema = {
      properties: { name: { type: "string" } },
    };
    const nodes = collect(schema);
    const child = nodes.find((n) => n.key === "name")!;
    expect(child.keyword).toBe("properties");
    expect(child.parent).toBe(schema);
  });

  it("skips boolean subschemas by default, visits them with visitBooleans", () => {
    const schema: JSONSchema = {
      properties: { open: true, closed: false },
    };
    expect(collect(schema).length).toBe(1); // root only
    expect(collect(schema, { visitBooleans: true }).length).toBe(3);
  });

  it("visits a subschema shared by two sibling positions at both", () => {
    const shared: JSONSchema = { type: "string" };
    const schema: JSONSchema = {
      properties: { a: shared, b: shared },
    };
    const paths = pathKeys(schema);
    expect(paths).toContain("properties/a");
    expect(paths).toContain("properties/b");
  });

  it("terminates on a self-referential (cyclic) object graph", () => {
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.properties = { self: cyclic };
    const nodes = collect(cyclic as JSONSchema);
    // root + the `self` edge; recursion into `self` hits the on-path guard.
    expect(nodes.map((n) => n.path.join("/"))).toEqual([
      "",
      "properties/self",
    ]);
  });
});

describe("anySchema / findSchema", () => {
  it("anySchema short-circuits and matches nested nodes", () => {
    const schema: JSONSchema = {
      properties: {
        a: { items: { ifc: { integrity: ["x"] } } },
      },
    };
    const hasIfc = (root: JSONSchema) =>
      anySchema(
        root,
        (n) => typeof n.schema === "object" && n.schema.ifc !== undefined,
      );
    expect(hasIfc(schema)).toBe(true);
    expect(hasIfc({ properties: { a: { type: "string" } } })).toBe(false);
  });

  it("findSchema returns the matching node with its path", () => {
    const schema: JSONSchema = {
      anyOf: [{ type: "string" }, { const: 3 }],
    };
    const node = findSchema(
      schema,
      (n) => typeof n.schema === "object" && n.schema.const === 3,
    );
    expect(node?.path.join("/")).toBe("anyOf/1");
  });
});

describe("deliberately-excluded keywords", () => {
  const hasIfc = (root: JSONSchema, opts?: Parameters<typeof anySchema>[2]) =>
    anySchema(
      root,
      (n) => typeof n.schema === "object" && n.schema.ifc !== undefined,
      opts,
    );

  it("does not descend patternProperties / contentSchema / if-then-else / etc.", () => {
    for (
      const keyword of [
        "patternProperties",
        "dependentSchemas",
      ]
    ) {
      expect(hasIfc({ [keyword]: { x: { ifc: { integrity: ["y"] } } } }))
        .toBe(false);
    }
    for (const keyword of ["if", "then", "else", "contains", "propertyNames"]) {
      expect(hasIfc({ [keyword]: { ifc: { integrity: ["y"] } } })).toBe(false);
    }
  });

  it("ignores `definitions` even when includeDefs is set (only `$defs`)", () => {
    const schema: JSONSchema = {
      definitions: { Old: { ifc: { integrity: ["y"] } } },
      $defs: { New: { type: "string" } },
    };
    expect(hasIfc(schema, { includeDefs: true })).toBe(false);
  });

  it("visits the excluded keywords when includeUnused is set", () => {
    for (const keyword of ["patternProperties", "dependentSchemas"]) {
      const schema: JSONSchema = {
        [keyword]: { x: { ifc: { integrity: ["y"] } } },
      };
      expect(hasIfc(schema)).toBe(false);
      expect(hasIfc(schema, { includeUnused: true })).toBe(true);
    }
    for (const keyword of ["if", "then", "else", "contains", "propertyNames"]) {
      const schema: JSONSchema = { [keyword]: { ifc: { integrity: ["y"] } } };
      expect(hasIfc(schema)).toBe(false);
      expect(hasIfc(schema, { includeUnused: true })).toBe(true);
    }
  });
});

describe("resolveRef option", () => {
  const rootWithDefs: JSONSchema = {
    $defs: { Labeled: { type: "string", ifc: { integrity: ["y"] } } },
    properties: { a: { $ref: "#/$defs/Labeled" } },
  };
  const resolveRef = (node: { $ref?: string }) =>
    node.$ref === "#/$defs/Labeled"
      ? (rootWithDefs as { $defs: Record<string, JSONSchema> }).$defs.Labeled
      : undefined;

  const hasIfc = (opts?: Parameters<typeof anySchema>[2]) =>
    anySchema(
      rootWithDefs,
      (n) => typeof n.schema === "object" && n.schema.ifc !== undefined,
      opts,
    );

  it("does not follow $ref by default (target label unseen)", () => {
    expect(hasIfc()).toBe(false);
  });

  it("follows $ref when a resolver is supplied", () => {
    expect(hasIfc({ resolveRef })).toBe(true);
  });

  it("marks resolved nodes viaRef, at the ref site's path", () => {
    const node = findSchema(
      rootWithDefs,
      (n) => typeof n.schema === "object" && n.schema.ifc !== undefined,
      { resolveRef },
    );
    expect(node?.viaRef).toBe(true);
    expect(node?.path.join("/")).toBe("properties/a");
  });

  it("terminates on a self-referential $ref chain", () => {
    const recursive: JSONSchema = {
      $defs: { Node: { properties: { next: { $ref: "#/$defs/Node" } } } },
      $ref: "#/$defs/Node",
    };
    const resolve = (n: { $ref?: string }) =>
      n.$ref === "#/$defs/Node"
        ? (recursive as { $defs: Record<string, JSONSchema> }).$defs.Node
        : undefined;
    // Should complete (the on-path guard breaks the ref cycle), not hang.
    let count = 0;
    walkSchema(recursive, () => {
      count++;
    }, { resolveRef: resolve });
    expect(count).toBeGreaterThan(0);
  });
});
