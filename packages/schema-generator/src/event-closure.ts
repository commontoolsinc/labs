import type { SchemaDefinition } from "./interface.ts";

type SchemaRecord = Record<string, unknown>;

const asSchemaRecord = (value: unknown): SchemaRecord | undefined =>
  typeof value === "object" && value !== null
    ? value as SchemaRecord
    : undefined;

/**
 * Close a verb EVENT schema's root: stamp `additionalProperties: false` so an
 * undeclared field in a call payload is a typed rejection at dispatch, never
 * silently stripped (verb contract design rule 1; the dispatch gate is C5's
 * `closedWorldEventRejection`). Applied only where generation KNOWS the
 * schema describes what a caller sends to a verb — the `Stream<E>` property
 * formatter and the transformer-injected handler event schema — never to
 * hand-authored schema literals, which stay author-owned.
 *
 * The stamp is position-scoped and conservative:
 *
 * - An inline object root gains the keyword directly.
 * - A `$ref` root gains it BESIDE the reference (sibling keywords apply
 *   conjunctively), so a shared `$defs` entry stays open at its other use
 *   sites — the def itself is never mutated.
 * - Anything that already declares `additionalProperties` — including a
 *   `$ref` whose def does (an index-signature event is the author's organic
 *   opt-out) — is left untouched: `false` beside a schema-valued constraint
 *   would override it conjunctively.
 * - Non-object roots (unions, primitives, `never`'s emission, booleans) are
 *   left untouched; closure of a union event is out of scope, and
 *   `never`-derived shapes must not read as intentional closure.
 */
export function closeVerbEventRoot(
  schema: unknown,
  definitions?: Record<string, SchemaDefinition | undefined>,
): unknown {
  const root = asSchemaRecord(schema);
  if (root === undefined) return schema;
  if (Object.hasOwn(root, "additionalProperties")) return schema;

  if (root.type === "object") {
    return { ...root, additionalProperties: false };
  }

  const ref = root.$ref;
  if (typeof ref === "string" && ref.startsWith("#/$defs/")) {
    const defName = ref.slice("#/$defs/".length);
    const defs = asSchemaRecord(root.$defs) ??
      (definitions as SchemaRecord | undefined);
    const target = asSchemaRecord(defs?.[defName]);
    if (
      target !== undefined &&
      target.type === "object" &&
      !Object.hasOwn(target, "additionalProperties")
    ) {
      return { ...root, additionalProperties: false };
    }
  }

  return schema;
}
