/**
 * Whether a JSON Schema bounds the read it drives.
 *
 * A schema handed to the runner is not only a description of a value; it is the
 * instruction set for materializing one. The traverser descends the properties
 * the schema names and follows every link it reaches, so the schema decides how
 * much of a space one `get()` touches. Two positions leave that unbounded:
 *
 * - An object position the schema does not close. With no `properties` and no
 *   `additionalProperties`, JSON Schema makes the position equivalent to
 *   `additionalProperties: true`, and the traverser descends every key the
 *   value happens to carry.
 * - A `$ref` on a cycle. The schema is finite and the data it drives need not
 *   be: a value whose links lead back to its own shape is followed for as deep
 *   as the links go.
 *
 * Either one against a space holding a large piece graph is work with no
 * ceiling, on whatever thread asked for it. So a caller that is about to read
 * at a schema checks it first and refuses a position it cannot bound, naming
 * the position so whoever wrote the schema can close it.
 *
 * The bound on this check: it decides the question from the schema's structure
 * alone, which is what lets it answer before any read. A closed schema can
 * still drive a large read — a hundred thousand declared rows are declared —
 * and nothing here says otherwise. It rules out the positions that have no
 * ceiling at all, not the reads that are merely big.
 */

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import {
  findSchema,
  forEachSubschema,
  type SchemaNode,
} from "@commonfabric/runner/schema-walk";
import { isObjectNotArray } from "@commonfabric/utils/types";

/** Why a schema position does not bound the read it drives. */
export type UnboundedSchemaReason =
  /** An object position admitting keys the schema does not name. */
  | "open-object"
  /** A `$ref` reachable from itself. */
  | "recursive-ref";

/** A schema position that does not bound the read it drives. */
export interface UnboundedSchemaPosition {
  /**
   * JSON Pointer to the position, within the schema that was checked —
   * `/properties/entries/items/properties/value`. The root is the empty
   * string.
   */
  readonly pointer: string;

  readonly reason: UnboundedSchemaReason;

  /** The `$ref` on the cycle, for a `recursive-ref` position. */
  readonly ref?: string;
}

/**
 * The keyword a local `$ref` goes through and the definition it names, or
 * `undefined` when `ref` is not a fragment-only reference into the root's
 * definition map. Capture 1 is the keyword, capture 2 the definition name.
 */
const LOCAL_REF_PATTERN = /^#\/(\$defs|definitions)\/([^/]+)$/;

/**
 * The definition name `ref` denotes, or `undefined` for a reference this check
 * does not resolve: an external one, a pointer into a nested definition scope,
 * or one at the root itself.
 *
 * Reference tokens are decoded per RFC 6901 — `~1` before `~0`, so the token
 * `a~01b` decodes to the name `a~1b` rather than to `a/b` — after the fragment
 * is percent-decoded, because a `$ref` is a URI and `%2F` is a separator
 * rather than part of a name.
 */
const localRefName = (ref: string): string | undefined => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(ref);
  } catch {
    return undefined;
  }
  const token = LOCAL_REF_PATTERN.exec(decoded)?.[2];
  return token === undefined || /~(?![01])/.test(token)
    ? undefined
    : token.replaceAll("~1", "/").replaceAll("~0", "~");
};

/** The JSON Pointer for a walk path, with each segment escaped per RFC 6901. */
const pointerForPath = (path: ReadonlyArray<string | number>): string =>
  path
    .map((segment) =>
      `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`
    )
    .join("");

/**
 * Whether `schema` admits an object value. A schema naming no `type` admits
 * every type, an object among them, which is why the open empty schema is
 * caught here rather than slipping through as untyped.
 */
const admitsObject = (schema: JSONSchemaObj): boolean => {
  const type = schema.type;
  if (type === undefined) {
    return true;
  }
  return Array.isArray(type) ? type.includes("object") : type === "object";
};

/**
 * Whether `node` is an object position the schema leaves open. A position
 * carrying `properties` and no `additionalProperties` is closed: the traverser
 * descends the named properties and leaves the rest alone. A position carrying
 * neither is the JSON Schema default of `additionalProperties: true`, and so is
 * an explicit `true`.
 *
 * A `$ref` defers the whole question to its target, and a combinator defers it
 * to its arms; both are positions the walk reaches on their own, so neither
 * answers here.
 */
const isOpenObjectPosition = (node: SchemaNode): boolean => {
  const schema = node.schema;
  if (schema === false) {
    return false;
  }
  if (schema === true) {
    return true;
  }
  if (!isObjectNotArray(schema) || typeof schema.$ref === "string") {
    return false;
  }
  if (!admitsObject(schema)) {
    return false;
  }
  const additional = (schema as { additionalProperties?: unknown })
    .additionalProperties;
  if (additional === true) {
    return true;
  }
  if (additional !== undefined) {
    return false;
  }
  // A combinator arm may be the thing that closes the position, so a schema
  // whose own keywords name nothing is left to the arms rather than refused
  // here.
  if (
    schema.allOf !== undefined || schema.anyOf !== undefined ||
    schema.oneOf !== undefined
  ) {
    return false;
  }
  return !isObjectNotArray(schema.properties);
};

/**
 * The local definition names `schema`'s own body refers to, not descending
 * into a nested definition scope — a subschema carrying its own `$defs`
 * resolves its references against that map rather than against the root's.
 */
const localRefNamesWithin = (schema: JSONSchema): ReadonlySet<string> => {
  const names = new Set<string>();
  const collect = (node: JSONSchema): void => {
    if (!isObjectNotArray(node)) {
      return;
    }
    if (typeof node.$ref === "string") {
      const name = localRefName(node.$ref);
      if (name !== undefined) {
        names.add(name);
      }
    }
    forEachSubschema(node, (child, keyword) => {
      if (
        keyword !== "$defs" &&
        !(isObjectNotArray(child) && child.$defs !== undefined)
      ) {
        collect(child);
      }
    }, { includeUnused: true });
  };
  collect(schema);
  return names;
};

/** The root's definition map, under either keyword, or an empty one. */
const rootDefinitions = (
  schema: JSONSchema,
): Readonly<Record<string, JSONSchema>> => {
  if (!isObjectNotArray(schema)) {
    return {};
  }
  const source = schema as {
    $defs?: unknown;
    definitions?: unknown;
  };
  const map = isObjectNotArray(source.$defs)
    ? source.$defs
    : isObjectNotArray(source.definitions)
    ? source.definitions
    : undefined;
  return map === undefined ? {} : map as Readonly<Record<string, JSONSchema>>;
};

/**
 * The name of a definition that is reachable from `schema` and reachable from
 * itself, or `undefined` when no definition is. Depth-first over the graph
 * whose nodes are the root's definitions and whose edges are the local `$ref`s
 * in each body, with the current path held so that a node found on it is a
 * cycle rather than a definition two siblings share.
 */
const recursiveDefinitionName = (schema: JSONSchema): string | undefined => {
  const definitions = rootDefinitions(schema);
  const settled = new Set<string>();
  const onPath = new Set<string>();
  const descend = (name: string): string | undefined => {
    if (onPath.has(name)) {
      return name;
    }
    if (settled.has(name) || !Object.hasOwn(definitions, name)) {
      return undefined;
    }
    onPath.add(name);
    for (const next of localRefNamesWithin(definitions[name])) {
      const found = descend(next);
      if (found !== undefined) {
        return found;
      }
    }
    onPath.delete(name);
    settled.add(name);
    return undefined;
  };
  for (const name of localRefNamesWithin(schema)) {
    const found = descend(name);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
};

/**
 * The first position of `schema` that does not bound the read it drives, or
 * `undefined` when every position does.
 *
 * An open object position is reported at its own pointer. A recursive `$ref`
 * is reported at the first reference to the definition on the cycle, which is
 * the position a caller can close; the cycle may run through several
 * definitions, and only the one entered twice is named.
 */
export const unboundedSchemaPosition = (
  schema: JSONSchema | undefined,
): UnboundedSchemaPosition | undefined => {
  if (schema === undefined) {
    return undefined;
  }
  const recursive = recursiveDefinitionName(schema);
  if (recursive !== undefined) {
    const ref = `#/$defs/${recursive}`;
    const site = findSchema(
      schema,
      (node) =>
        isObjectNotArray(node.schema) &&
        typeof node.schema.$ref === "string" &&
        localRefName(node.schema.$ref) === recursive,
      { includeDefs: true },
    );
    return {
      pointer: site === undefined ? "" : pointerForPath(site.path),
      reason: "recursive-ref",
      ref,
    };
  }
  // `$defs` bodies are walked too: a definition no reference reaches drives no
  // read, but one that is reached is read at whatever shape it declares, and
  // the walk has no way to tell a reached body from an orphan.
  const open = findSchema(schema, isOpenObjectPosition, {
    includeDefs: true,
    visitBooleans: true,
  });
  return open === undefined ? undefined : {
    pointer: pointerForPath(open.path),
    reason: "open-object",
  };
};

/**
 * What to tell whoever wrote a schema carrying `position`: where the position
 * is, why it has no ceiling, and what closing it takes.
 *
 * `label` names the schema in the caller's own vocabulary, so the sentence
 * reads as being about the thing they passed.
 */
export const unboundedSchemaPositionMessage = (
  label: string,
  position: UnboundedSchemaPosition,
): string => {
  const at = position.pointer === ""
    ? "at its root"
    : `at \`${position.pointer}\``;
  return position.reason === "recursive-ref"
    ? `${label} is recursive ${at}: \`${position.ref}\` is reachable from itself, so reading at this schema follows a value's links for as deep as they go. Declare the depth you need as nested properties instead of referring back to the enclosing shape.`
    : `${label} leaves an object open ${at}: it admits keys it does not name, so reading at this schema descends every key the value carries and follows every link it reaches. Declare the properties you need — an \`object\` with no \`properties\` asks for the whole graph.`;
};
