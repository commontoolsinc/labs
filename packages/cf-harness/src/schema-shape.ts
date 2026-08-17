/**
 * Reduction of a JSON Schema to the part of it that is STRUCTURE: property
 * names, types, nesting, required-ness, and array/object composition. The
 * result is what `describe_handle` may disclose about a referent whose schema
 * the harness did not write.
 *
 * The rule is deny-by-default. A reduced schema is REBUILT from an allowlist
 * of structural keywords rather than copied with a few keywords deleted, so a
 * keyword nobody thought about is absent rather than disclosed, and so is
 * every keyword nested inside `properties`, `items`, `$defs`, or a
 * combinator. That matters because a schema is a place a value can hide:
 * `const`, `enum`, `default`, and `examples` carry values outright, and
 * `title`, `description`, `$comment`, and `pattern` carry free text that
 * whoever authored the schema chose. A shape tells a model what code to
 * write; none of the rest is needed to write it.
 */

import type { JSONSchema, JSONSchemaTypes } from "@commonfabric/api";
import { FABRIC_PRIMITIVE_SCHEMA_TYPES } from "@commonfabric/api";

/**
 * The `type` vocabulary passed through. A closed set, so a `type` cannot be
 * repurposed as a free-text field: an unrecognized one is dropped along with
 * everything else outside the allowlist.
 */
const DISCLOSABLE_TYPES: ReadonlySet<string> = new Set<string>([
  "object",
  "array",
  "string",
  "integer",
  "number",
  "boolean",
  "null",
  "undefined",
  "unknown",
  ...FABRIC_PRIMITIVE_SCHEMA_TYPES,
]);

/**
 * The `format` vocabulary passed through — the formats the runner's own
 * validator recognizes. Closed for the same reason `type` is: a format is a
 * refinement of a type, and an unrecognized one is free text.
 */
const DISCLOSABLE_FORMATS: ReadonlySet<string> = new Set([
  "email",
  "uri",
  "date",
  "date-time",
]);

/**
 * A local `$ref` pointer, which is structure: it names a `$defs` entry whose
 * key is disclosed anyway. Any other reference — a URI, a pointer into
 * something this schema does not carry — is dropped rather than reported.
 */
const LOCAL_REF_PATTERN = /^#(?:\/(?:\$defs|definitions)\/[^/~]+)?$/;

const isSchemaRecord = (
  schema: JSONSchema,
): schema is Exclude<JSONSchema, boolean> =>
  typeof schema === "object" && schema !== null && !Array.isArray(schema);

/** Structural keywords whose value is a single subschema. */
const SUBSCHEMA_KEYS = [
  "items",
  "contains",
  "additionalProperties",
  "not",
] as const;

/** Structural keywords whose value is an array of subschemas. */
const SUBSCHEMA_LIST_KEYS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;

/** Structural keywords whose value is a name-to-subschema map. */
const SUBSCHEMA_MAP_KEYS = ["properties", "$defs", "definitions"] as const;

const reduceType = (
  type: unknown,
): JSONSchemaTypes | JSONSchemaTypes[] | undefined => {
  if (typeof type === "string" && DISCLOSABLE_TYPES.has(type)) {
    return type as JSONSchemaTypes;
  }
  if (Array.isArray(type)) {
    const kept = type.filter(
      (entry): entry is JSONSchemaTypes =>
        typeof entry === "string" && DISCLOSABLE_TYPES.has(entry),
    );
    return kept.length > 0 ? kept : undefined;
  }
  return undefined;
};

/**
 * Reduces `schema` to structure, dropping every keyword outside the
 * allowlist at every depth. A boolean schema is structure already and passes
 * through; anything that is not a schema at all reduces to `{}`, the shape
 * that says nothing.
 *
 * Recursion is guarded by the set of schema objects on the CURRENT path, so a
 * schema that contains itself reduces to `{}` at the point it closes the
 * loop, while a subschema shared between two siblings is reduced once for
 * each.
 */
export const schemaShapeOnly = (schema: JSONSchema): JSONSchema =>
  reduceSchema(schema, new Set<object>());

const reduceSchema = (
  schema: JSONSchema,
  active: Set<object>,
): JSONSchema => {
  if (typeof schema === "boolean") {
    return schema;
  }
  if (!isSchemaRecord(schema)) {
    return {};
  }
  if (active.has(schema)) {
    return {};
  }
  active.add(schema);
  try {
    const source = schema as Record<string, unknown>;
    const shape: Record<string, unknown> = {};

    const type = reduceType(source.type);
    if (type !== undefined) {
      shape.type = type;
    }

    const ref = source.$ref;
    if (typeof ref === "string" && LOCAL_REF_PATTERN.test(ref)) {
      shape.$ref = ref;
    }

    const format = source.format;
    if (typeof format === "string" && DISCLOSABLE_FORMATS.has(format)) {
      shape.format = format;
    }

    for (const key of SUBSCHEMA_KEYS) {
      const child = source[key];
      if (child !== undefined) {
        shape[key] = reduceSchema(child as JSONSchema, active);
      }
    }

    for (const key of SUBSCHEMA_LIST_KEYS) {
      const children = source[key];
      if (Array.isArray(children)) {
        shape[key] = children.map((child) =>
          reduceSchema(child as JSONSchema, active)
        );
      }
    }

    for (const key of SUBSCHEMA_MAP_KEYS) {
      const children = source[key];
      if (isSchemaRecord(children as JSONSchema)) {
        const reduced: Record<string, JSONSchema> = {};
        for (
          const [name, child] of Object.entries(
            children as Record<string, JSONSchema>,
          )
        ) {
          Object.defineProperty(reduced, name, {
            value: reduceSchema(child, active),
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
        shape[key] = reduced;
      }
    }

    // `required` is disclosed as required-ness of names already disclosed
    // through `properties`. A name required but never declared is not
    // structure — it is a string whoever wrote the schema chose — so it is
    // dropped, and with no `properties` beside it the whole keyword is.
    const declared = shape.properties as Record<string, JSONSchema> | undefined;
    if (Array.isArray(source.required) && declared !== undefined) {
      const kept = source.required.filter(
        (name): name is string =>
          typeof name === "string" &&
          Object.hasOwn(declared, name),
      );
      if (kept.length > 0) {
        shape.required = kept;
      }
    }

    return shape as JSONSchema;
  } finally {
    active.delete(schema);
  }
};
