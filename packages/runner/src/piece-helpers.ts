import {
  entityRefToString,
  isEntityRef,
} from "@commonfabric/data-model/cell-rep";
// TODO(@ubik2): Ideally this would import from "@commonfabric/utils/types",
// but rollup has issues
import { isRecord } from "../../utils/src/types.ts";
import { type Cell, isCell } from "./cell.ts";
import { isSigilLink } from "./link-types.ts";
import { parseLink } from "./link-utils.ts";
import { DEFAULT_CELL_SCOPE, scopeRank } from "./scope.ts";
import type { MemorySpace } from "./storage/interface.ts";
import type { JSONSchema, Pattern } from "./builder/types.ts";
import type { Runtime } from "./runtime.ts";
import type { RuntimeProgram } from "./harness/types.ts";

export type CellPath = (string | number)[];

export function parseCellPath(path: string): CellPath {
  if (!path || path.trim() === "") {
    return [];
  }
  return path.split("/").map((segment) => {
    if (segment === "") {
      return segment;
    }
    const num = Number(segment);
    return Number.isInteger(num) && num >= 0 ? num : segment;
  });
}

export function resolveCellPath<T>(
  cell: Cell<T>,
  path: CellPath,
): unknown {
  let currentCell = cell as Cell<unknown>;
  let parentValue: unknown = undefined;

  for (const segment of path) {
    parentValue = currentCell.get() as unknown;
    // An asCell-schema slot surfaces its value as a live Cell (the
    // Writable<...> result shape); read through it like the leaf below
    // does, or the traversal inspects the Cell instance's own JS
    // properties and reports runner internals as "available keys".
    if (isCell(parentValue)) {
      currentCell = parentValue as Cell<unknown>;
      parentValue = currentCell.get() as unknown;
    }
    if (parentValue != null && typeof parentValue !== "object") {
      throw new Error(
        `Cannot access path "${
          path.join("/")
        }" - encountered non-object at "${segment}"`,
      );
    }
    currentCell = currentCell.key(segment as keyof unknown) as Cell<unknown>;
  }

  const resolvedValue = currentCell.get();
  const segment = path[path.length - 1];
  const keyMissing = parentValue != null && typeof parentValue === "object"
    ? !(segment in (parentValue as object))
    : resolvedValue === undefined;
  if (path.length > 0 && keyMissing) {
    const availableKeys = parentValue != null && typeof parentValue === "object"
      ? Object.keys(parentValue as Record<string, unknown>)
        .filter((k) => !k.startsWith("$"))
        .sort()
      : [];
    const keysHint = availableKeys.length > 0
      ? `. Available keys: ${availableKeys.join(", ")}`
      : "";
    throw new Error(
      `Cannot access path "${path.join("/")}" - property "${
        String(segment)
      }" not found${keysHint}`,
    );
  }

  return isCell(resolvedValue) ? resolvedValue.get() : resolvedValue;
}

export function cellEntityIdString(cell: Cell<unknown>): string | undefined {
  const id = cell.entityId;
  return isEntityRef(id) ? entityRefToString(id) : undefined;
}

/**
 * Derive a read-time projection schema in which `required` no longer claims
 * properties whose STORED value is a link into a narrower-than-space scope
 * (user/session).
 *
 * Why: pattern result schemas mark every output property `required`, but an
 * output derived from a scoped cell lives in a session/user-scoped doc that
 * only the owning session can materialize. For every other session the strict
 * schema projection finds the required property unresolvable and voids the
 * ENTIRE object (`traverseObjectWithSchema`'s required check) — so a path-less
 * piece read returns `undefined` while every child-path read works. Per the
 * #4746 contract, partial visibility must be expressed in the schema rather
 * than special-cased in the traverser; this helper is the piece read boundary
 * doing exactly that, driven by the stored links' own declared scopes.
 *
 * Deliberately NOT relaxed: plain (non-link) missing properties, properties
 * whose links are space-scoped, and anything inside arrays (#4746 restored
 * strict required semantics for array elements; nothing here reopens that).
 * Recurses only through inline records — links are boundaries.
 *
 * Returns the input schema by reference when there is nothing to relax, so
 * schema identity (and downstream hash caching) is preserved.
 */
export function schemaWithScopedLinkRequiredsRelaxed(
  schema: JSONSchema | undefined,
  rawValue: unknown,
  base: Cell<unknown>,
): JSONSchema | undefined {
  if (
    !isRecord(schema) || !isRecord(rawValue) || isSigilLink(rawValue) ||
    Array.isArray(rawValue)
  ) {
    return schema;
  }

  // A scoped output does not carry its scope on the first link: the result
  // doc's property links (scope "space") redirect to an intermediate doc
  // whose value is the actual `{scope: "session"|"user"}` redirect into the
  // scoped instance. Walk the redirect chain (bounded) and flag the property
  // if ANY hop declares a narrower-than-space scope. A hop whose doc is not
  // locally readable ends the walk as "not narrow" — the conservative
  // fallback is the pre-existing strict behavior.
  const isNarrowScopedLink = (value: unknown): boolean => {
    let current = value;
    let currentBase = base;
    for (let hop = 0; hop < 8; hop++) {
      if (!isSigilLink(current)) return false;
      // Parsing against the containing cell resolves "inherit" to the
      // containing scope, so the normalized scope is always concrete.
      const link = parseLink(current, currentBase);
      if (link === undefined) return false;
      const scope = link.scope ?? DEFAULT_CELL_SCOPE;
      if (scopeRank(scope) > scopeRank(DEFAULT_CELL_SCOPE)) return true;
      let next: Cell<unknown>;
      let raw: unknown;
      try {
        next = currentBase.runtime.getCellFromLink(link);
        raw = next.getRaw();
      } catch {
        return false;
      }
      current = raw;
      currentBase = next;
    }
    return false;
  };

  let changed = false;

  let required = schema.required;
  if (Array.isArray(required)) {
    const kept = required.filter(
      (prop) =>
        typeof prop !== "string" ||
        !isNarrowScopedLink((rawValue as Record<string, unknown>)[prop]),
    );
    if (kept.length !== required.length) {
      required = kept;
      changed = true;
    }
  }

  let properties = schema.properties;
  if (isRecord(properties)) {
    let newProperties: Record<string, JSONSchema> | undefined;
    for (const [key, propSchema] of Object.entries(properties)) {
      const propValue = (rawValue as Record<string, unknown>)[key];
      // Links are boundaries: a linked doc's own read applies its own schema.
      if (isSigilLink(propValue)) continue;
      const relaxed = schemaWithScopedLinkRequiredsRelaxed(
        propSchema as JSONSchema,
        propValue,
        base,
      );
      if (relaxed !== propSchema) {
        newProperties ??= { ...(properties as Record<string, JSONSchema>) };
        newProperties[key] = relaxed as JSONSchema;
      }
    }
    if (newProperties !== undefined) {
      properties = newProperties;
      changed = true;
    }
  }

  if (!changed) return schema;
  return {
    ...schema,
    ...(properties !== undefined ? { properties } : {}),
    ...(required !== undefined ? { required } : {}),
  } as JSONSchema;
}

/**
 * Return `cell` re-schema'd for a terminal whole-object read: `required`
 * entries that point at narrower-scoped stored links are relaxed via
 * {@link schemaWithScopedLinkRequiredsRelaxed}. Returns the cell unchanged
 * when it carries no schema, the raw value is unreadable, or nothing needed
 * relaxing.
 */
export function cellWithScopedLinkRequiredsRelaxed<T>(
  cell: Cell<T>,
): Cell<T> {
  const schema = cell.schema;
  if (schema === undefined) return cell;
  let raw: unknown;
  try {
    raw = cell.getRaw();
  } catch {
    return cell;
  }
  const relaxed = schemaWithScopedLinkRequiredsRelaxed(
    schema,
    raw,
    cell as Cell<unknown>,
  );
  return relaxed === schema ? cell : cell.asSchema<T>(relaxed);
}

export function getResultCellWithSourceSchema<T = unknown>(
  cell: Cell<T>,
): Cell<T> {
  const link = cell.getAsNormalizedFullLink();
  if (link.schema === undefined) {
    const resultSchema = cell.getMetaRaw("schema") as JSONSchema | undefined;
    if (resultSchema !== undefined) {
      const schema = cell.runtime.cfc.schemaAtPath(resultSchema, link.path);
      return cell.asSchema<T>(schema);
    }
  }
  return cell;
}

/**
 * Compile a pattern into `space` and persist its content-addressed source +
 * compiled documents there (the awaited write-back inside `compilePattern`).
 * The compiled pattern carries its `{ identity, symbol }` entry ref, the single
 * durable pattern pointer; no separate meta-cell save is needed. (Formerly
 * `compileAndSavePattern`, which additionally wrote a now-deleted meta cell.)
 */
export async function compileAndSavePattern(
  runtime: Runtime,
  patternSrc: string | RuntimeProgram,
  options: {
    space: MemorySpace;
    previousEntryIdentity?: string;
  },
): Promise<Pattern> {
  if (typeof patternSrc === "string") {
    patternSrc = {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: patternSrc }],
    };
  }
  // Route through the content-addressed cell cache in the target space so the
  // compiled module set + source docs are written back (awaited) and reused on
  // subsequent loads (CT-1623).
  const pattern = await runtime.patternManager.compilePattern(patternSrc, {
    space: options.space,
    ...(options.previousEntryIdentity === undefined
      ? {}
      : { previousEntryIdentity: options.previousEntryIdentity }),
  });
  if (!pattern) {
    throw new Error("No default pattern found in the compiled exports.");
  }

  return pattern;
}
