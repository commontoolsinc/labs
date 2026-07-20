// Compares the shared schema-walk implementations against faithful copies of
// the pre-migration originals. Focus: the traversal cost of the value-semantics
// detectors on the hot path — the common case is "no ifc anywhere", i.e. a FULL
// traversal that returns false, which is the worst case for a walker.
//
//   deno bench --no-check test/schema-walk.bench.ts

import { isRecord } from "@commonfabric/utils/types";
import { anySchema, forEachSubschema } from "../src/schema-walk.ts";

// deno-lint-ignore no-explicit-any
type S = any;

// ---------------------------------------------------------------------------
// Faithful copies of the ORIGINAL (pre-migration) implementations.
// ---------------------------------------------------------------------------

// schema-merge.ts:260 (HEAD) — array-spread `.some` recursion, structural only.
const oldBranchContainsIfc = (schema: S): boolean => {
  if (!isRecord(schema)) return false;
  const object = schema;
  if (object.ifc !== undefined) return true;
  return [
    ...(object.anyOf ?? []),
    ...(object.oneOf ?? []),
    ...(object.allOf ?? []),
    ...(object.prefixItems ?? []),
    ...(object.items ? [object.items] : []),
    ...(object.properties ? Object.values(object.properties) : []),
    ...(object.$defs ? Object.values(object.$defs) : []),
    ...(isRecord(object.additionalProperties)
      ? [object.additionalProperties]
      : []),
  ].some(oldBranchContainsIfc);
};

// schema.ts:511 (HEAD) — the `_schemaHasIfcUncached` descent, minus the $ref /
// cache / scope machinery (identical on both sides here; benches carry no $ref).
const oldHasIfc = (schema: S): boolean => {
  if (!isRecord(schema)) return false;
  if (schema.ifc !== undefined) return true;
  const compound = [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
  ];
  if (compound.some((x: S) => isRecord(x) && oldHasIfc(x))) return true;
  if (
    schema.properties &&
    Object.values(schema.properties).some((x: S) => isRecord(x) && oldHasIfc(x))
  ) return true;
  if (
    isRecord(schema.additionalProperties) && oldHasIfc(schema.additionalProperties)
  ) return true;
  if (isRecord(schema.items) && oldHasIfc(schema.items)) return true;
  return false;
};

// schema-refs.ts (HEAD) — the local keyword lists + forEachSubschema, used to
// count every subschema node (a stand-in for the enumeration cost).
const OLD_SINGLE = [
  "not", "if", "then", "else", "items", "contains",
  "additionalProperties", "propertyNames", "contentSchema",
];
const OLD_ARRAY = ["allOf", "anyOf", "oneOf", "prefixItems"];
const OLD_RECORD = ["dependentSchemas", "properties", "patternProperties"];
const oldCountNodes = (schema: S): number => {
  if (!isRecord(schema)) return 0;
  let n = 1;
  for (const key of OLD_SINGLE) {
    if (schema[key] !== undefined) n += oldCountNodes(schema[key]);
  }
  for (const key of OLD_ARRAY) {
    for (const child of schema[key] ?? []) n += oldCountNodes(child);
  }
  for (const key of OLD_RECORD) {
    for (const child of Object.values(schema[key] ?? {})) {
      n += oldCountNodes(child);
    }
  }
  return n;
};

// ---------------------------------------------------------------------------
// NEW implementations (matching the migrated call sites).
// ---------------------------------------------------------------------------

// What the migrated `branchContainsIfc` does today: anySchema → walkSchema
// (builds a path + node object per node).
const anySchemaHasIfc = (schema: S): boolean =>
  anySchema(schema, (node) => (node.schema as S).ifc !== undefined);

// What the migrated `schemaHasIfc` / `branchContainsIfc` do today:
// forEachSubschema (callback) + manual recursion, no path / node object.
const edgesHasIfc = (schema: S): boolean => {
  if (!isRecord(schema)) return false;
  if ((schema as S).ifc !== undefined) return true;
  return forEachSubschema(schema, (child) => edgesHasIfc(child));
};

const newCountNodes = (schema: S): number => {
  const seen = new Set<S>();
  const walk = (s: S): number => {
    if (!isRecord(s) || seen.has(s)) return 0;
    seen.add(s);
    let n = 1;
    forEachSubschema(s, (child) => {
      n += walk(child);
    });
    return n;
  };
  return walk(schema);
};

// ---------------------------------------------------------------------------
// Representative schemas — all WITHOUT ifc, so every detector fully traverses.
// ---------------------------------------------------------------------------

const leaf = (): S => ({ type: "string" });

const small: S = {
  type: "object",
  properties: { a: leaf(), b: leaf(), c: leaf(), d: leaf(), e: leaf() },
};

const wide: S = {
  type: "object",
  properties: Object.fromEntries(
    Array.from({ length: 60 }, (_, i) => [`p${i}`, leaf()]),
  ),
};

const deep: S = (() => {
  let s: S = leaf();
  for (let i = 0; i < 25; i++) s = { type: "object", properties: { child: s } };
  return s;
})();

// A vdom-ish mix: nested objects, an array with item schema, an anyOf union,
// and prefixItems — the shapes real result/argument schemas actually take.
const realistic: S = {
  type: "object",
  properties: {
    id: leaf(),
    title: leaf(),
    author: {
      type: "object",
      properties: { name: leaf(), email: leaf(), handle: leaf() },
    },
    tags: { type: "array", items: leaf() },
    body: {
      anyOf: [
        { type: "object", properties: { kind: { const: "text" }, text: leaf() } },
        {
          type: "object",
          properties: {
            kind: { const: "list" },
            items: { type: "array", items: leaf() },
          },
        },
      ],
    },
    coords: { type: "array", prefixItems: [leaf(), leaf()] },
    meta: {
      type: "object",
      properties: {
        created: leaf(),
        updated: leaf(),
        extra: { type: "object", additionalProperties: leaf() },
      },
    },
  },
};

const shapes: Record<string, S> = { small, wide, deep, realistic };

for (const [name, schema] of Object.entries(shapes)) {
  const nodes = newCountNodes(schema);
  const label = `${name} (${nodes} nodes)`;

  // hasIfc semantics: the two originals vs the shared-walk variants —
  // forEachSubschema (the current detector impl) and anySchema (the pricier
  // path-building visitor).
  Deno.bench(`hasIfc OLD-targeted — ${label}`, {
    group: `hasIfc:${name}`,
    baseline: true,
  }, () => {
    oldHasIfc(schema);
  });
  Deno.bench(`hasIfc old-branchContains — ${label}`, {
    group: `hasIfc:${name}`,
  }, () => {
    oldBranchContainsIfc(schema);
  });
  Deno.bench(`hasIfc NEW-forEachSubschema — ${label}`, {
    group: `hasIfc:${name}`,
  }, () => {
    edgesHasIfc(schema);
  });
  Deno.bench(`hasIfc NEW-anySchema — ${label}`, {
    group: `hasIfc:${name}`,
  }, () => {
    anySchemaHasIfc(schema);
  });

  Deno.bench(`enumerate OLD-16key — ${label}`, {
    group: `enumerate:${name}`,
    baseline: true,
  }, () => {
    oldCountNodes(schema);
  });
  Deno.bench(`enumerate NEW-forEachSubschema — ${label}`, {
    group: `enumerate:${name}`,
  }, () => {
    newCountNodes(schema);
  });
}
