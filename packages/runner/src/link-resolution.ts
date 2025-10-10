import { isObject, isRecord, type Mutable } from "@commontools/utils/types";
import { getLogger } from "@commontools/utils/logger";
import { LINK_V1_TAG } from "./sigil-types.ts";
import {
  type CellLink,
  type NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { type JSONSchema } from "./builder/types.ts";

const logger = getLogger("link-resolution");

/**
 * Create an allOf schema from multiple schemas, implementing JSON Schema
 * intersection semantics.
 *
 * This function combines multiple schemas into a single allOf schema, with
 * intelligent handling of special properties:
 *
 * **Extraction Rules:**
 * - `default`: Last non-undefined value wins (allows later schemas to override
 *   defaults)
 * - `asCell`/`asStream`: First non-undefined value wins (reactivity flag from
 *   earliest schema)
 * - Both flags are extracted as siblings to the allOf array, not inside
 *   branches
 *
 * **Trivial Schema Filtering:** Filters out schemas that add no meaningful
 * constraints:
 * - `undefined` - no schema
 * - `true` - allows anything
 * - Schemas with only internal keys (e.g., `{ asCell: true }` with no other
 *   properties)
 *
 * Note: Flags like `asCell` are extracted BEFORE filtering, so a schema like `{
 * asCell: true }` will contribute its flag even though it's considered trivial.
 *
 * **Return Values:**
 * - `undefined` - if no non-trivial schemas (but may return `{ asCell: true }`
 *   if flag was extracted)
 * - Single schema - if only one non-trivial schema (with extracted flags merged
 *   in)
 * - `{ allOf: [...], default?, asCell?, asStream? }` - if multiple non-trivial
 *   schemas
 *
 * @param schemas - Array of schemas to combine (may include undefined, true, or
 * trivial schemas)
 * @returns Combined schema, or undefined if no meaningful schemas provided
 *
 * @example
 * ```typescript
 * // Simple case - combines two schemas
 * createAllOf([
 *   { type: "string" },
 *   { minLength: 5 }
 * ])
 * // => { allOf: [{ type: "string" }, { minLength: 5 }] }
 *
 * // Extracts default (last wins)
 * createAllOf([
 *   { type: "number", default: 1 },
 *   { type: "number", default: 2 }
 * ])
 * // => { allOf: [{ type: "number" }, { type: "number" }], default: 2 }
 *
 * // Extracts asCell (first wins)
 * createAllOf([
 *   { type: "string", asCell: true },
 *   { type: "string", asCell: false }
 * ])
 * // => { allOf: [{ type: "string" }, { type: "string" }], asCell: true }
 *
 * // Filters trivial schemas
 * createAllOf([
 *   undefined,
 *   { type: "string" },
 *   true
 * ])
 * // => { type: "string" }
 * ```
 */
export function createAllOf(
  schemas: { schema?: JSONSchema; rootSchema?: JSONSchema }[],
): { schema?: JSONSchema; rootSchema?: JSONSchema } {
  // Extract asCell/asStream from first schema that has either BEFORE filtering.
  // This is intentional: a schema like { asCell: true } is considered "trivial"
  // (adds no type constraints), but we still need to extract and preserve the
  // flag.
  let hasAsCell = false;
  let hasAsStream = false;

  let $defs: Record<string, JSONSchema> | undefined;

  if (
    schemas.length === 0 ||
    schemas.every(({ schema }) => schema === undefined)
  ) {
    return {};
  }

  // If any are false, nothing matches
  if (schemas.some(({ schema }) => schema === false)) {
    return { schema: false };
  }

  for (const { schema } of schemas) {
    if (isObject(schema)) {
      // Only extract the first flag we encounter
      if (schema.asCell && !hasAsCell && !hasAsStream) {
        hasAsCell = true;
        break;
      }
      if (schema.asStream && !hasAsStream && !hasAsCell) {
        hasAsStream = true;
        break;
      }
    }
  }

  for (const { rootSchema } of schemas) {
    if (isObject(rootSchema) && rootSchema.$defs) {
      $defs = { ...$defs, ...rootSchema.$defs };
    }
  }

  const combinedRootSchema: JSONSchema | undefined = $defs
    ? { $defs }
    : undefined;

  // Filter out trivial schemas (undefined, true, or schemas with only internal keys)
  const nonTrivial = schemas.map(({ schema }) => schema).filter((schema) =>
    schema !== undefined && !ContextualFlowControl.isTrueSchema(schema)
  ) as (JSONSchema & object)[];

  if (nonTrivial.length === 0) {
    // No non-trivial schemas, but we might have extracted asCell/asStream
    if (hasAsCell || hasAsStream) {
      return {
        schema: {
          ...(hasAsCell ? { asCell: true } : {}),
          ...(hasAsStream ? { asStream: true } : {}),
        },
      };
    } else {
      // true, since in every other case we'd have returned earlier
      return { schema: true };
    }
  }

  // Extract defaults from last schema that has them (last wins)
  let extractedDefault: any = undefined;
  let hasDefault = false;
  for (let i = nonTrivial.length - 1; i >= 0; i--) {
    const schema = nonTrivial[i];
    if (isObject(schema) && "default" in schema) {
      extractedDefault = schema.default;
      hasDefault = true;
      break;
    }
  }

  const seen = new Set<string>();

  // Remove extracted properties from branches to avoid duplication
  // Also remove any competing flags (e.g., remove asStream if asCell was extracted)
  const cleanedSchemas = nonTrivial.map((schema) => {
    if (!isObject(schema)) return schema;
    const {
      default: _default,
      asCell: _asCell,
      asStream: _asStream,
      ...cleaned
    } = schema;
    return cleaned;
  });

  const deduplicatedSchemas: (JSONSchema & object)[] = [];
  for (const schema of cleanedSchemas) {
    const key = JSON.stringify(schema);
    if (seen.has(key)) continue;
    seen.add(key);
    deduplicatedSchemas.push(schema);
  }

  if (deduplicatedSchemas.length === 1) {
    // Single non-trivial schema: add extracted flags to it
    return {
      schema: {
        ...deduplicatedSchemas[0],
        ...(hasAsCell && { asCell: true }),
        ...(hasAsStream && { asStream: true }),
      },
      rootSchema: combinedRootSchema,
    };
  } else {
    return {
      schema: {
        allOf: deduplicatedSchemas,
        ...(hasDefault ? { default: extractedDefault } : {}),
        ...(hasAsCell ? { asCell: true } : {}),
        ...(hasAsStream ? { asStream: true } : {}),
      },
      rootSchema: combinedRootSchema,
    };
  }
}

export type LastNode = "value" | "writeRedirect" | "top";

/**
 * A resolved link is a link that has been resolved to a document that no longer
 * has any links between the top and the value at `link.path`.
 */
declare const resolvedFullLinkBrand: unique symbol;
export type ResolvedFullLink = NormalizedFullLink & {
  // type-script only marker, doesn't appear in actual data
  [resolvedFullLinkBrand]: true;
};

const MAX_PATH_RESOLUTION_LENGTH = 100;

/**
 * Resolves a document path with support for links inside documents.
 *
 * It returns a `ResolvedFullLink` that points to a document that no longer has
 * any links between the top and the value at `link.path`. When a cycle is
 * detected, a warning is logged and a static link to `undefined` returned.
 *
 * `lastNode` controls whether to follow links on the last path segment. By
 * default all links are followed, but if `lastNode` is `LastNode.WriteRedirect`
 * only write redirects are followed and if `lastNode` is `LastNode.Top` no
 * links are followed at all.
 *
 * Links can point to another (document, path) pair, and may appear either at
 * leaf nodes or in the middle of a document. This resolver transparently
 * follows such links and detects cycles.
 *
 * A cycle is detected if the exact (document, path) pair is visited more than
 * once. This detects cycles like:
 * - A/foo → A/foo
 * - A → B → C → A
 *
 * But there are cycles that can lead to growing paths, e.g.
 * - A → A/foo
 * - A → B, B → A/foo
 *
 * These are difficult to detect, since there are many legitimate cases for the
 * same link to be followed several times, so instead we just have an upper
 * bound of 1000 iterations, and log a warning.
 *
 * @param tx - The storage transaction to read from.
 * @param link - The link to read.
 * @param lastNode - The last node in the path.
 * @returns The resolved link.
 */
export function resolveLink(
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  lastNode: LastNode = "value",
): ResolvedFullLink {
  const seen = new Set<string>();

  const cfc = new ContextualFlowControl();

  let iteration = 0;

  // Accumulate schemas from the link chain (but not the initial link's schema,
  // as that's our starting point, not something we're combining with)
  const schemasFromChain: { schema?: JSONSchema; rootSchema?: JSONSchema }[] =
    [];

  // If there is a schema on the initial link, add it to the chain and remove it
  // from the link.
  if (link.schema) {
    schemasFromChain.push({ schema: link.schema, rootSchema: link.rootSchema });
    link = { ...link, schema: undefined, rootSchema: undefined };
  }

  while (true) {
    if (iteration++ > MAX_PATH_RESOLUTION_LENGTH) {
      logger.warn(`Link resolution iteration limit reached`);
      return createEmptyResolvedFullLink(link); // = return link to empty document
    }

    // Detect cycles.
    const key = JSON.stringify([link.space, link.id, link.path]);
    if (seen.has(key)) {
      logger.warn(`Link cycle detected ${key}`);
      return createEmptyResolvedFullLink(link); // = return link to empty document
    }
    seen.add(key);

    // Optimized fast-path: a single sigil probe at the full remaining path.
    // If not a sigil link, use that error's path to check legacy or parent once.
    let nextLink: NormalizedFullLink | undefined;

    // Sigil probe at full path
    const sigilProbe = tx.read({
      ...link,
      path: ["value", ...link.path, "/", LINK_V1_TAG],
    });
    if (
      sigilProbe.ok &&
      isRecord(sigilProbe.ok.value) &&
      lastNode !== "top" &&
      (lastNode !== "writeRedirect" ||
        sigilProbe.ok.value.overwrite === "redirect")
    ) {
      // Read the full value at this path to ensure correct reactivity logging
      // (we need to be reactive to siblings that could invalidate the link)
      const whole = tx.readValueOrThrow({ ...link, path: link.path });
      nextLink = parseLink(whole as CellLink, link);
    } else if (sigilProbe.error?.name === "NotFoundError") {
      const lastValid = sigilProbe.error.path?.slice(); // undefined => doc missing

      if (lastValid) {
        // remove `value` prefix
        lastValid.shift();

        // remove last path element (it's valid in that it can be addressed,
        // but we want to assume it doesn't exist and look for a link there
        // instead)
        lastValid.pop();

        if (lastValid.length === link.path.length) {
          // full path candidate, only check legacy-at full path
          const legacy = checkLegacyAt(
            tx,
            link,
            lastValid,
            lastNode === "writeRedirect",
          );
          if (legacy) {
            nextLink = legacy;
          }
        } else {
          // Check sigil at this parent, then legacy
          const parentSigil = tx.read({
            ...link,
            path: ["value", ...lastValid, "/", LINK_V1_TAG],
          });
          if (parentSigil.ok && isRecord(parentSigil.ok.value)) {
            // Read the full value at the parent to ensure proper reactivity
            const whole = tx.readValueOrThrow({ ...link, path: lastValid });
            nextLink = parseLink(whole as CellLink, {
              ...link,
              path: lastValid,
            });
          } else {
            nextLink = checkLegacyAt(tx, link, lastValid, false);
          }
        }

        if (nextLink) {
          // Append the remaining path to the next link:

          // Remaining path is the path from the last valid path to the end of
          // the link path
          const remainingPath = link.path.slice(lastValid.length);

          // Advance the schema of the next link by the remaining path
          let linkSchema = nextLink.schema;
          if (linkSchema !== undefined && remainingPath.length > 0) {
            const cfc = new ContextualFlowControl();
            linkSchema = cfc.getSchemaAtPath(
              linkSchema,
              remainingPath,
              nextLink.rootSchema,
            );
          }

          // Construct new link with the remaining path and the advanced schema
          nextLink = {
            ...nextLink,
            path: [...nextLink.path, ...remainingPath],
            ...(linkSchema ? { schema: linkSchema } : {}),
          };

          // Advance all schemas found along the chain by the remaining path
          for (const chainSchema of schemasFromChain) {
            chainSchema.schema = cfc.getSchemaAtPath(
              chainSchema.schema,
              remainingPath,
              chainSchema.rootSchema,
            );
          }
        }
      }
      // If still nothing found we fall through and break the loop
    }

    if (nextLink !== undefined) {
      // If a schema is found on the next link, add it to the chain and remove
      // it from the link.
      if (nextLink.schema) {
        schemasFromChain.push({
          schema: nextLink.schema,
          rootSchema: nextLink.rootSchema,
        });
        nextLink = {
          ...nextLink,
          schema: undefined,
          rootSchema: undefined,
        };
      }

      link = nextLink;
    } else {
      break;
    }
  }

  const combinedSchema = createAllOf(schemasFromChain);
  const result = { ...link, ...combinedSchema } satisfies NormalizedFullLink;

  // Remove overwrite field, i.e. when the last followed link was a write
  // redirect. The idea is that this is a link pointing to the final value, it
  // doesn't matter how we got there.
  delete result.overwrite;

  // The casting is a workaround for the branding, we don't actually want to add
  // the symbol to the result.
  return result as unknown as ResolvedFullLink;
}

function checkLegacyAt(
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  atPath: readonly string[],
  onlyRedirects: boolean,
): NormalizedFullLink | undefined {
  const aliasPath = tx.read({
    ...link,
    path: ["value", ...atPath, "$alias", "path"],
  });
  if (Array.isArray(aliasPath.ok?.value)) {
    return parseLink(
      tx.readValueOrThrow({ ...link, path: atPath }) as CellLink,
      { ...link, path: atPath },
    );
  }
  if (onlyRedirects) return undefined;
  const legacyCell = tx.read({
    ...link,
    path: ["value", ...atPath, "cell", "/"],
  });
  if (typeof legacyCell.ok?.value === "string") {
    return parseLink(
      tx.readValueOrThrow({ ...link, path: atPath }) as CellLink,
      { ...link, path: atPath },
    );
  }
  return undefined;
}

/**
 * Read a value that might be a link.
 *
 * We're first checking for the deeper link paths, so that we're not reactive to
 * other changes in the doc. If it looks like it could be a link, read the whole
 * value, which might include siblings to the "/" and thus make the link
 * invalid. In these cases, we do need to be reactive to all changes there.
 *
 * @param tx - The storage transaction to read from.
 * @param link - The link to read.
 * @param onlyWriteRedirects - Whether to only read write redirects.
 * @returns The value that might be a link.
 */
export function readMaybeLink(
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  onlyWriteRedirects = false,
): NormalizedFullLink | undefined {
  const readSubPath = (extraPath: string[]) =>
    tx.readValueOrThrow({ ...link, path: [...link.path, ...extraPath] });

  const maybeSigilLink = readSubPath(["/", LINK_V1_TAG]);
  if (
    // Sigil link:
    (isRecord(maybeSigilLink) &&
      (!onlyWriteRedirects || maybeSigilLink.overwrite === "redirect")) ||
    // Legacy cell link:
    (!onlyWriteRedirects && typeof readSubPath(["cell", "/"]) === "string" &&
      Array.isArray(readSubPath(["path"]))) ||
    // Legacy alias:
    Array.isArray(readSubPath(["$alias", "path"]))
  ) {
    return parseLink(readSubPath([]) as CellLink, link);
  } else {
    return undefined;
  }
}

function createEmptyResolvedFullLink(
  link: NormalizedFullLink,
): ResolvedFullLink {
  return {
    ...link,
    id: "data:application/json,{}",
    path: [],
    type: "application/json",
    space: "did:null:null",
  } satisfies NormalizedFullLink as unknown as ResolvedFullLink;
}
