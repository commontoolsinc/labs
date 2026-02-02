import { isRecord } from "@commontools/utils/types";
import { getLogger } from "@commontools/utils/logger";
import { LINK_V1_TAG, type LinkV1Inner } from "./sigil-types.ts";
import {
  type CellLink,
  type NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import type {
  IExtendedStorageTransaction,
  INotFoundError,
} from "./storage/interface.ts";
import { ContextualFlowControl } from "./cfc.ts";
import type { Runtime } from "./runtime.ts";

const logger = getLogger("link-resolution");

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
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  lastNode: LastNode = "value",
): ResolvedFullLink {
  const seen = new Set<string>();

  let iteration = 0;

  while (true) {
    if (iteration++ > MAX_PATH_RESOLUTION_LENGTH) {
      logger.error("link-res-error", `Link resolution iteration limit reached`);
      throw new Error(`Link resolution iteration limit reached`);
    }

    // Detect cycles.
    const key = JSON.stringify([link.space, link.id, link.path]);
    if (seen.has(key)) {
      logger.error(
        "link-res-error",
        `Link cycle detected ${key} [${JSON.stringify([...seen])}]`,
      );
      throw new Error(
        `Link cycle detected at ${key} [${JSON.stringify([...seen])}]`,
      );
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
        (sigilProbe.ok.value as LinkV1Inner).overwrite === "redirect")
    ) {
      // Read the full value at this path to ensure correct reactivity logging
      // (we need to be reactive to siblings that could invalidate the link)
      const whole = tx.readValueOrThrow({ ...link, path: link.path });
      nextLink = parseLink(whole as CellLink, link);
    } else if (sigilProbe.error?.name === "NotFoundError") {
      const lastValid = (sigilProbe.error as INotFoundError).path.slice(); // [] => doc missing

      if (lastValid.length > 0) {
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
          let { schema, ...restLink } = nextLink;
          if (schema !== undefined && remainingPath.length > 0) {
            const cfc = new ContextualFlowControl();
            schema = cfc.getSchemaAtPath(schema, remainingPath);
          }
          nextLink = {
            ...restLink,
            path: [...nextLink.path, ...remainingPath],
            ...(schema !== undefined && { schema }),
          };
        }
      }
      // If still nothing found we fall through and break the loop
    }

    if (nextLink !== undefined) {
      const crossSpace = nextLink.space !== link.space;
      if (nextLink.schema === undefined && link.schema !== undefined) {
        link = {
          ...nextLink,
          schema: link.schema,
        };
      } else {
        link = nextLink;
      }
      // If we're crossing spaces, force fetching data from server, as the
      // original server will not have pushed the data to the client yet.
      if (crossSpace) {
        const maybePromise = runtime.getCellFromLink(link).sync();
        if (maybePromise instanceof Promise) {
          const promise = maybePromise.finally(() => {
            runtime.storageManager.removeCrossSpacePromise(promise);
          }) as unknown as Promise<void>;
          runtime.storageManager.addCrossSpacePromise(promise);
        }
      }
    } else {
      break;
    }
  }

  const result = { ...link } satisfies NormalizedFullLink;

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
