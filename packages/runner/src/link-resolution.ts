import { getLogger } from "@commonfabric/utils/logger";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import {
  linkPayloadAtProbe,
  linkProbeSubPath,
} from "@commonfabric/data-model/cell-rep";
import { type CellLinkRefPayload } from "./sigil-types.ts";
import { dataURIFromValueWithResolvedLinks } from "./data-uri.ts";
import {
  type CellLink,
  type NormalizedFullLink,
  parseLink,
  toMemorySpaceAddress,
} from "./link-utils.ts";
import type {
  IExtendedStorageTransaction,
  INotFoundError,
} from "./storage/interface.ts";
import { linkResolutionProbe } from "./storage/reactivity-log.ts";
import { ContextualFlowControl } from "./cfc.ts";
import type { Runtime } from "./runtime.ts";
import type { CfcAddress } from "./cfc/types.ts";
import { canFollowScopedLink } from "./scope.ts";
import type { SchemaScope } from "./builder/types.ts";

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

type LinkHop = {
  link: NormalizedFullLink;
  source: NormalizedFullLink;
  kind: "value" | "write-redirect";
};

const cfcAddressFromLink = (link: NormalizedFullLink): CfcAddress => ({
  space: link.space,
  id: link.id,
  scope: link.scope,
  path: [...link.path],
});

const hopKindForLink = (
  link: NormalizedFullLink,
): LinkHop["kind"] =>
  link.overwrite === "redirect" ? "write-redirect" : "value";

const recordDereferenceHop = (
  tx: IExtendedStorageTransaction,
  hop: LinkHop,
): void => {
  tx.recordCfcDereferenceTrace({
    source: cfcAddressFromLink(hop.source),
    target: cfcAddressFromLink(hop.link),
    kind: hop.kind,
  });
};

// The scope cap a link's schema imposes on the next link it permits a read to
// follow (see ContextualFlowControl.getSchemaScopeCap for the precedence). This
// caps *which* link scopes may be followed; it must never be copied onto the
// followed link itself.
const schemaScopeForLink = (
  link: NormalizedFullLink,
): SchemaScope | undefined =>
  ContextualFlowControl.getSchemaScopeCap(link.schema);

const undefinedDataLink = (link: NormalizedFullLink): NormalizedFullLink => ({
  ...link,
  id: dataURIFromValueWithResolvedLinks(undefined, link),
  path: [],
});

const canFollowLinkHop = (
  source: NormalizedFullLink,
  target: NormalizedFullLink,
): boolean => canFollowScopedLink(schemaScopeForLink(source), target.scope);

/**
 * Resolves a document path with support for links inside documents.
 *
 * It returns a `ResolvedFullLink` that points to a document that no longer has
 * any links between the top and the value at `link.path`. When a cycle is
 * detected, an error is logged and thrown.
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
 * A link whose target passes back through the link's own position in the same
 * document (e.g. A → A/foo) makes the path grow on every hop, so the pair
 * never repeats; that shape is detected separately on the first hop.
 *
 * Growing-path cycles that span documents, e.g.
 * - A → B, B → A/foo
 *
 * are difficult to detect, since there are many legitimate cases for the
 * same link to be followed several times, so they are bounded by an upper
 * limit of `MAX_PATH_RESOLUTION_LENGTH` iterations, which throws.
 *
 * @param tx - The storage transaction to read from.
 * @param link - The link to read.
 * @param lastNode - The last node in the path.
 * @param options - Allows you to preserve the `overwrite` field if needed
 * @returns The resolved link.
 */
export function resolveLink(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  lastNode: LastNode = "value",
  options: { preserveOverwrite?: boolean } = {},
): ResolvedFullLink {
  const seen = new Set<string>();

  let iteration = 0;

  while (true) {
    if (iteration++ > MAX_PATH_RESOLUTION_LENGTH) {
      logger.error("link-res-error", `Link resolution iteration limit reached`);
      throw new Error(`Link resolution iteration limit reached`);
    }

    // Detect cycles.
    const key = JSON.stringify([link.space, link.id, link.scope, link.path]);
    if (seen.has(key)) {
      logger.error(
        "link-res-error",
        `Link cycle detected ${key} [${toCompactDebugString([...seen])}]`,
      );
      throw new Error(
        `Link cycle detected at ${key} [${toCompactDebugString([...seen])}]`,
      );
    }
    seen.add(key);

    // Optimized fast-path: a single sigil probe at the full remaining path.
    // If not a sigil link, use that error's path to check legacy or parent once.
    let nextHop: LinkHop | undefined;

    // Sigil probe at full path. Probe reads are shape observations of link
    // topology — flow labels must not treat them as content reads
    // (reactivity still does, so the link appearing later re-resolves).
    const sigilProbe = tx.read(
      toMemorySpaceAddress({
        ...link,
        path: [...link.path, ...linkProbeSubPath()],
      }),
      { meta: linkResolutionProbe },
    );
    const probePayload = sigilProbe.ok
      ? linkPayloadAtProbe(sigilProbe.ok.value)
      : undefined;
    if (
      probePayload !== undefined &&
      lastNode !== "top" &&
      (lastNode !== "writeRedirect" ||
        (probePayload as CellLinkRefPayload).overwrite === "redirect")
    ) {
      // Read the full value at this path to ensure correct reactivity logging
      // (we need to be reactive to siblings that could invalidate the link)
      const whole = tx.readValueOrThrow({ ...link, path: link.path });
      const nextLink = parseLink(whole as CellLink, link);
      nextHop = {
        link: nextLink,
        source: { ...link, path: [...link.path] },
        kind: hopKindForLink(nextLink),
      };
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
          const legacy = checkLegacyAt(tx, link, lastValid);
          if (legacy) {
            nextHop = {
              link: legacy,
              source: { ...link, path: [...lastValid] },
              kind: hopKindForLink(legacy),
            };
          }
        } else {
          // Check sigil at this parent, then legacy
          const parentSigil = tx.read(
            toMemorySpaceAddress({
              ...link,
              path: [...lastValid, ...linkProbeSubPath()],
            }),
            { meta: linkResolutionProbe },
          );
          if (
            parentSigil.ok &&
            linkPayloadAtProbe(parentSigil.ok.value) !== undefined
          ) {
            // Read the full value at the parent to ensure proper reactivity
            const whole = tx.readValueOrThrow({ ...link, path: lastValid });
            const nextLink = parseLink(whole as CellLink, {
              ...link,
              path: lastValid,
            });
            nextHop = {
              link: nextLink,
              source: { ...link, path: [...lastValid] },
              kind: hopKindForLink(nextLink),
            };
          } else {
            const legacy = checkLegacyAt(tx, link, lastValid);
            if (legacy) {
              nextHop = {
                link: legacy,
                source: { ...link, path: [...lastValid] },
                kind: hopKindForLink(legacy),
              };
            }
          }
        }

        if (nextHop) {
          const remainingPath = link.path.slice(lastValid.length);
          let { schema, ...restLink } = nextHop.link;
          if (schema !== undefined && remainingPath.length > 0) {
            const cfc = new ContextualFlowControl();
            schema = cfc.getSchemaAtPath(schema, remainingPath);
          }
          nextHop = {
            ...nextHop,
            link: {
              ...restLink,
              path: [...nextHop.link.path, ...remainingPath],
              ...(schema !== undefined && { schema }),
            },
          };
        }
      }
      // If still nothing found we fall through and break the loop
    }

    if (nextHop !== undefined) {
      if (!canFollowLinkHop(link, nextHop.link)) {
        // Blocked narrower-scope follow during link resolution — resolves to
        // undefined silently. Warn (not info) so the drop is observable; see
        // the matching site in traverse.ts followPointer (CT-1642).
        const schemaScope = schemaScopeForLink(link);
        logger.warn("scope: blocked narrower link follow", () => [
          `a "${schemaScope}"-scoped read cannot follow a ` +
          `"${nextHop.link.scope}"-scoped link, so it resolves to undefined. ` +
          `If this is inside a .map()/lift, resolve the narrower-scoped value ` +
          `at the top level and pass the value down.`,
          {
            schemaScope,
            linkScope: nextHop.link.scope,
            source: cfcAddressFromLink(link),
            target: cfcAddressFromLink(nextHop.link),
          },
        ]);
        link = undefinedDataLink(link);
        break;
      }
      // A link whose target passes back through the link's own position can
      // never resolve: the value at that position is the link itself, so
      // every hop re-follows it with a longer path and the (document, path)
      // cycle key never repeats. Detect this on the first hop.
      const hopSource = nextHop.source;
      const hopTarget = nextHop.link;
      if (
        hopTarget.space === hopSource.space &&
        hopTarget.id === hopSource.id &&
        hopTarget.scope === hopSource.scope &&
        hopTarget.path.length > hopSource.path.length &&
        hopSource.path.every((part, i) => hopTarget.path[i] === part)
      ) {
        const detail = `link at [${hopSource.path.join("/")}] targets its ` +
          `own subpath [${hopTarget.path.join("/")}]`;
        logger.error("link-res-error", `Link cycle detected: ${detail}`);
        throw new Error(`Link cycle detected at ${key}: ${detail}`);
      }
      recordDereferenceHop(tx, nextHop);
      const nextLink = nextHop.link;
      const crossSpace = nextLink.space !== link.space;
      if (nextLink.schema === undefined && link.schema !== undefined) {
        link = {
          ...nextLink,
          schema: link.schema,
        };
      } else {
        link = nextLink;
      }
      // Force fetching data from the server when the local replica cannot
      // serve the hop target: crossing spaces (the origin server never pushes
      // other-space docs), or a same-space doc this replica has never pulled.
      // The second arm is the fresh-replica read-asymmetry fix: selector
      // driven syncs only deliver what a schema covered, so a link can point
      // at a same-space doc no selector ever walked — without this kick such
      // reads mask as `undefined`, indistinguishable from absence. The kick
      // is async; one-shot reads still return the masked value, but
      // `Cell.pull()`'s convergence loop awaits the tracked sync and re-reads.
      const mgr = runtime.storageManager;
      const { space, id, scope } = link;
      const reserved = !crossSpace &&
        mgr.shouldPullDoc?.(space, id, scope) === true;
      if (crossSpace || reserved) {
        // Swallow sync failures: this kick is best-effort (the read still
        // resolves from the local replica) and an unhandled rejection here
        // would otherwise escape the resolution path. On failure, retract
        // the shouldPullDoc reservation so a later read may retry — but only
        // when THIS kick took it: a failed cross-space kick never reserved,
        // and must not clear a reservation a concurrent same-space read
        // holds for the same target (that would permit duplicate syncs).
        mgr.trackUntilSettled(
          runtime.getCellFromLink(link).sync().catch(() => {
            if (reserved) mgr.retractDocPullKick?.(space, id, scope);
          }),
        );
      }
    } else {
      break;
    }
  }

  const result = { ...link } satisfies NormalizedFullLink;

  // Intern the schema at this single link-resolution exit so downstream
  // consumers see an identity-canonical, deep-frozen schema reference.
  // `getSchemaAtPath` (called within the loop above) can emit freshly-
  // constructed schemas; interning here collapses structurally-equal
  // outputs to the same `===` reference across calls, letting
  // identity-based caches downstream hit rather than miss.
  result.schema = internSchema(result.schema);

  // Remove overwrite field, i.e. when the last followed link was a write
  // redirect. The idea is that this is a link pointing to the final value, it
  // doesn't matter how we got there.
  if (!options.preserveOverwrite) {
    delete result.overwrite;
  }

  // The casting is a workaround for the branding, we don't actually want to add
  // the symbol to the result.
  return result as unknown as ResolvedFullLink;
}

function checkLegacyAt(
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  atPath: readonly string[],
): NormalizedFullLink | undefined {
  const aliasPath = tx.read(
    toMemorySpaceAddress({
      ...link,
      path: [...atPath, "$alias", "path"],
    }),
    { meta: linkResolutionProbe },
  );
  if (Array.isArray(aliasPath.ok?.value)) {
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
  const readSubPath = (extraPath: readonly string[]) =>
    tx.readValueOrThrow({ ...link, path: [...link.path, ...extraPath] });

  const maybeSigilPayload = linkPayloadAtProbe(readSubPath(linkProbeSubPath()));
  if (
    // Sigil link: { "/": { "link@1": { id: <id>, ... } } }
    (maybeSigilPayload !== undefined &&
      (!onlyWriteRedirects ||
        (maybeSigilPayload as CellLinkRefPayload).overwrite === "redirect")) ||
    // Legacy alias: { $alias: { path: [] } }
    Array.isArray(readSubPath(["$alias", "path"]))
  ) {
    return parseLink(readSubPath([]) as CellLink, link);
  } else {
    return undefined;
  }
}
