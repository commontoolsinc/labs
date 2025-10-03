import { isObject, isRecord } from "@commontools/utils/types";
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
 * Create an allOf schema from multiple schemas, skipping trivial cases.
 * Returns undefined if no non-trivial schemas, a single schema if only one,
 * or an allOf if multiple non-trivial schemas.
 *
 * When creating allOf, extracts defaults (last wins) and asCell/asStream (first wins)
 * as siblings to the allOf array.
 */
export function createAllOf(schemas: JSONSchema[]): JSONSchema | undefined {
  // Extract asCell/asStream from first schema that has either BEFORE filtering
  // (important: a schema like { asCell: true } is considered "trivial" but we need the flag)
  let hasAsCell = false;
  let hasAsStream = false;
  for (const schema of schemas) {
    if (schema === undefined || schema === true) continue;
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

  // Filter out trivial schemas (undefined, true, or schemas with only internal keys)
  const nonTrivial = schemas.filter((s) =>
    s !== undefined &&
    s !== true &&
    !ContextualFlowControl.isTrueSchema(s)
  );

  if (nonTrivial.length === 0) {
    // No non-trivial schemas, but we might have extracted asCell/asStream
    if (hasAsCell || hasAsStream) {
      return {
        ...(hasAsCell ? { asCell: true } : {}),
        ...(hasAsStream ? { asStream: true } : {}),
      };
    }
    return undefined;
  }
  if (nonTrivial.length === 1) {
    // Single non-trivial schema: add extracted flags to it
    const schema = nonTrivial[0];
    if (hasAsCell || hasAsStream) {
      return {
        ...ContextualFlowControl.toSchemaObj(schema),
        ...(hasAsCell ? { asCell: true } : {}),
        ...(hasAsStream ? { asStream: true } : {}),
      };
    }
    return schema;
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

  // Remove extracted properties from branches to avoid duplication
  // Also remove any competing flags (e.g., remove asStream if asCell was extracted)
  const cleanedBranches = nonTrivial.map((schema) => {
    if (!isObject(schema)) return schema;
    const cleaned = { ...schema };
    if (hasDefault && "default" in cleaned) {
      delete (cleaned as any).default;
    }
    // Remove the extracted flag
    if (hasAsCell && cleaned.asCell) {
      delete (cleaned as any).asCell;
    }
    if (hasAsStream && cleaned.asStream) {
      delete (cleaned as any).asStream;
    }
    // Remove competing flags (override behavior)
    if (hasAsCell && cleaned.asStream) {
      delete (cleaned as any).asStream;
    }
    if (hasAsStream && cleaned.asCell) {
      delete (cleaned as any).asCell;
    }
    return cleaned;
  });

  return {
    allOf: cleanedBranches,
    ...(hasDefault ? { default: extractedDefault } : {}),
    ...(hasAsCell ? { asCell: true } : {}),
    ...(hasAsStream ? { asStream: true } : {}),
  };
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

  let iteration = 0;

  // Accumulate schemas from the link chain (but not the initial link's schema,
  // as that's our starting point, not something we're combining with)
  const schemasFromChain: JSONSchema[] = [];

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
          const remainingPath = link.path.slice(lastValid.length);
          let linkSchema = nextLink.schema;
          if (linkSchema !== undefined && remainingPath.length > 0) {
            const cfc = new ContextualFlowControl();
            linkSchema = cfc.getSchemaAtPath(
              linkSchema,
              remainingPath,
              nextLink.rootSchema,
            );
          }
          nextLink = {
            ...nextLink,
            path: [...nextLink.path, ...remainingPath],
            ...(linkSchema ? { schema: linkSchema } : {}),
          };
        }
      }
      // If still nothing found we fall through and break the loop
    }

    if (nextLink !== undefined) {
      // Accumulate schemas when we actually follow a link to a new location
      // Only combine if the schemas are different (to avoid combining a schema with itself)
      const schemasAreDifferent = nextLink.schema && link.schema &&
        JSON.stringify(nextLink.schema) !== JSON.stringify(link.schema);

      if (schemasAreDifferent) {
        // Both current and next have schemas and they're different - need to combine them
        if (schemasFromChain.length === 0) {
          // First time we're combining - add the current link's schema
          schemasFromChain.push(link.schema!);
        }
        schemasFromChain.push(nextLink.schema!);
      } else if (nextLink.schema && !link.schema) {
        // Only next has schema - this becomes our new schema (might combine later)
        schemasFromChain.push(nextLink.schema);
      }

      if (nextLink.schema === undefined && link.schema !== undefined) {
        link = {
          ...nextLink,
          schema: link.schema,
          rootSchema: link.rootSchema,
        };
      } else {
        link = nextLink;
      }
    } else {
      break;
    }
  }

  const result = { ...link } satisfies NormalizedFullLink;

  // Combine all schemas from the chain into an allOf (only if more than one)
  if (schemasFromChain.length > 1) {
    const combinedSchema = createAllOf(schemasFromChain);
    if (combinedSchema) {
      result.schema = combinedSchema;
      // Keep the rootSchema from the last link, or use the combined schema
      result.rootSchema = result.rootSchema ?? combinedSchema;
    }
  }

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
