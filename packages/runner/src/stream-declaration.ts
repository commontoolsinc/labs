/**
 * What a schema declares about the handle at its root, read the one way
 * every reader reads it. A stream's document stores nothing that says what
 * it is: the declaration is on the schema of a link that names the stream —
 * the manifest link its owner keeps for it among them — so a reader that
 * has to tell a stream from a value reads a schema, and this module is that
 * reading. It carries none of the runtime, so a reader holding stored
 * documents and no live cells can take it as it is; the one thing that
 * differs between the two, how an external schema reference is resolved,
 * arrives as a function.
 */

import type {
  AsCellEntry,
  CellKind,
  JSONSchema,
  JSONSchemaObj,
} from "@commonfabric/api";
import { isExternalSchemaRef } from "@commonfabric/data-model-schema/schema-refs";
import { decodeJsonPointer } from "@commonfabric/utils/json-pointer";
import { isObjectOrArray } from "@commonfabric/utils/types";

/** The handle kind `schema` declares by its own root `asCell`, if any. */
function rootAsCellKind(schema: JSONSchema | undefined): CellKind | undefined {
  if (!isObjectOrArray(schema) || !Array.isArray(schema.asCell)) {
    return undefined;
  }
  const front = schema.asCell[0] as AsCellEntry | undefined;
  return typeof front === "string" ? front : front?.kind;
}

/**
 * The definition name a `#/$defs/<name>` reference names, or `undefined` for
 * any other reference.
 */
export function localDefinitionName(ref: string): string | undefined {
  if (!ref.startsWith("#")) return undefined;
  const path = decodeJsonPointer(ref);
  return path.length === 3 && path[0] === "#" && path[1] === "$defs" &&
      path[2] !== ""
    ? path[2]
    : undefined;
}

/**
 * The definition `root` carries under `name` in its `$defs`, or `undefined`
 * where it carries none, or carries something there that is not a schema.
 */
export function definitionNamed(
  root: JSONSchema | undefined,
  name: string,
): JSONSchema | undefined {
  if (!isObjectOrArray(root)) return undefined;
  const defs = root.$defs;
  if (!isObjectOrArray(defs) || !Object.hasOwn(defs, name)) return undefined;
  const definition = (defs as Record<string, unknown>)[name];
  return isObjectOrArray(definition) || typeof definition === "boolean"
    ? definition as JSONSchema
    : undefined;
}

/**
 * The definition a `#/$defs/<name>` reference names in `root`, or `undefined`
 * for any other reference or a name `root` does not define. A miss is quiet:
 * this is asked of every position a read passes, and most carry no `$defs`
 * closure at all.
 */
export function localDefinition(
  root: JSONSchema | undefined,
  ref: string,
): JSONSchema | undefined {
  const name = localDefinitionName(ref);
  return name === undefined ? undefined : definitionNamed(root, name);
}

/**
 * What an external schema reference resolved to: the schema it names, and
 * the document the local references inside that schema resolve against —
 * the referenced document itself, whose `$defs` those references name.
 */
export interface ResolvedExternalReference {
  readonly schema: JSONSchema;

  /** The document a local `$ref` in `schema` names a definition of. */
  readonly root: JSONSchema;
}

/**
 * Resolves a schema whose root `$ref` is an external (`cid:`) reference,
 * given the schema carrying it. `undefined` where the reference names
 * nothing the reader can supply, and where the reader refuses the schema's
 * form; either way the position declares nothing. The runtime answers this
 * from its schema registry, and a reader over stored documents from the
 * documents it holds.
 */
export type ExternalReferenceResolver = (
  schema: JSONSchemaObj,
) => ResolvedExternalReference | undefined;

/** What a reading of a declaration is given besides the schema. */
export interface DeclarationReading {
  /**
   * The document local `$ref`s resolve against. Defaults to the schema
   * itself, which a link's schema is self-contained enough for, and moves to
   * the resolved document when an external reference is followed.
   */
  readonly root?: JSONSchema;

  /**
   * How an external reference is followed. Without one, a position declared
   * through an external reference declares nothing.
   */
  readonly resolveExternal?: ExternalReferenceResolver;
}

/**
 * The kind of handle `schema` declares at its root, read through a root
 * `$ref` — external, or into the root's own `$defs` — and through a
 * composition whose branches agree: `allOf` declares what any of its branches
 * declares, and `anyOf`/`oneOf` what every branch declares, since the value
 * may be any of them. `undefined` where nothing is declared, or where the
 * branches disagree, or where a reference does not resolve.
 *
 * `active` is the descent under way. It stops a reference from being followed
 * back into itself; a definition two sibling branches share is read once for
 * each, since the first branch has left it by the time the second arrives.
 */
export function declaredHandleKind(
  schema: JSONSchema | undefined,
  reading: DeclarationReading = {},
  active: Set<object> = new Set(),
): CellKind | undefined {
  if (!isObjectOrArray(schema) || active.has(schema)) return undefined;
  active.add(schema);
  try {
    let root = reading.root ?? schema;
    let resolved: JSONSchema = schema;
    if (typeof schema.$ref === "string" && isExternalSchemaRef(schema.$ref)) {
      // The guard above established an object carrying a string `$ref`,
      // which is the shape the resolver is typed over.
      const external = reading.resolveExternal?.(schema as JSONSchemaObj);
      if (external === undefined) return undefined;
      resolved = external.schema;
      root = external.root;
    }
    if (!isObjectOrArray(resolved)) return undefined;
    const direct = rootAsCellKind(resolved);
    if (direct !== undefined) return direct;
    const below = (branch: JSONSchema | undefined): CellKind | undefined =>
      declaredHandleKind(
        branch,
        { root, resolveExternal: reading.resolveExternal },
        active,
      );
    if (typeof resolved.$ref === "string") {
      return below(localDefinition(root, resolved.$ref));
    }
    const agreed = (
      branches: unknown,
      every: boolean,
    ): CellKind | undefined => {
      if (!Array.isArray(branches) || branches.length === 0) return undefined;
      let kind: CellKind | undefined;
      for (const branch of branches) {
        const declared = below(branch as JSONSchema);
        if (declared === undefined) {
          if (every) return undefined;
          continue;
        }
        if (kind !== undefined && kind !== declared) return undefined;
        kind = declared;
      }
      return kind;
    };
    return agreed(resolved.allOf, false) ?? agreed(resolved.anyOf, true) ??
      agreed(resolved.oneOf, true);
  } finally {
    active.delete(schema);
  }
}

/**
 * Whether `schema` declares a stream position: the handle kind it declares
 * ({@link declaredHandleKind}) is `stream`. Such a position holds no value,
 * and its handle is minted from the schema alone.
 */
export function declaresStream(
  schema: JSONSchema | undefined,
  resolveExternal?: ExternalReferenceResolver,
): boolean {
  return declaredHandleKind(schema, { resolveExternal }) === "stream";
}
