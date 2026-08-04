import { getLogger } from "@commonfabric/utils/logger";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import {
  linkPayloadAtProbe,
  linkProbeSubPath,
} from "@commonfabric/data-model/cell-rep";
import { type CellLinkRefPayload } from "./sigil-types.ts";
import { dataUriFromValueWithResolvedLinks } from "./data-uri.ts";
import {
  type CellLink,
  type NormalizedFullLink,
  parseLink,
  type ScopeCapAtDepth,
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
import { canFollowScopedLink, narrowerScopeCap } from "./scope.ts";
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
  /**
   * How many of the resolving link's path segments the stored link sits under.
   * Equal to `link.path.length` for a hop found at the full path, and shorter
   * when the hop was discovered at an ancestor — which is the case that has to
   * consult `scopeCaps` rather than the leaf schema.
   */
  depth: number;
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
//
// `link.schema` describes the LEAF, so it only answers for a hop found at the
// full path. A hop found at an ancestor is governed by whatever that ancestor's
// schema declared, which `key()` recorded in `scopeCaps` on its way down —
// narrowing had already replaced the declaring schema by the time we get here
// (#5230).
//
// For an ancestor hop we take the NARROWER of the recorded cap and the leaf's.
// The leaf cap is not really the right authority there — it describes a
// different address — but applying it to ancestor hops is what this resolver
// has always done, and a link that never passed through `key()` carries no
// recorded caps at all. Keeping it as a floor means this change can only block
// more than before, never less.
//
// This floor is load-bearing, not just belt-and-braces: a link assembled
// directly (`runtime.getCellFromLink` with a multi-segment path) has no
// recorded caps at all, and removing the floor lets such a read follow a
// narrower link that main blocks. Pinned by a test.
/**
 * Shift recorded caps onto a link's target after a hop consumed `consumed`
 * leading segments. Caps at or below the hop are dropped (already enforced);
 * the rest move by `shift` so their depths still address the same segments.
 */
const rebaseScopeCaps = (
  caps: readonly ScopeCapAtDepth[] | undefined,
  consumed: number,
  shift: number,
): readonly ScopeCapAtDepth[] | undefined => {
  if (caps === undefined) return undefined;
  const moved = caps
    .filter((cap) => cap.depth > consumed)
    .map((cap) => ({ depth: cap.depth + shift, scope: cap.scope }));
  return moved.length > 0 ? moved : undefined;
};

const schemaScopeForLinkAtDepth = (
  link: NormalizedFullLink,
  depth: number,
): SchemaScope | undefined => {
  // getSchemaScopeCap only reads the top level, so a cap wrapped in
  // anyOf/oneOf is invisible to it. A mixed compound (`[<capped handle>,
  // {type:"null"}]`) never mints a handle at all -- the link is simply
  // followed -- so this is the only place that shape can be caught.
  const leafCap = narrowerScopeCap(
    ContextualFlowControl.getSchemaScopeCap(link.schema),
    ContextualFlowControl.getAsCellFollowScopeCap(link.schema),
  );
  if (depth >= link.path.length) return leafCap;
  return narrowerScopeCap(
    link.scopeCaps?.find((cap) => cap.depth === depth)?.scope,
    leafCap,
  );
};

/**
 * The link a blocked or dead-ended chain resolves to: undefined-data in place.
 * Exported so every site that decides a link may not be followed produces the
 * same shape — notably the asCell boundaries, which build a handle instead of
 * following and so never reach the check below (#5230).
 */
export const undefinedDataLink = (
  link: NormalizedFullLink,
): NormalizedFullLink => {
  // `path` is rebased to [], so any recorded cap depths now address segments
  // of a different document. Drop them rather than leave them misaligned.
  const { scopeCaps: _dropped, ...rest } = link;
  return {
    ...rest,
    id: dataUriFromValueWithResolvedLinks(undefined, link),
    path: [],
  };
};

const canFollowLinkHop = (
  source: NormalizedFullLink,
  hop: LinkHop,
): boolean =>
  canFollowScopedLink(
    schemaScopeForLinkAtDepth(source, hop.depth),
    hop.link.scope,
  );

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
 * @param options - `preserveOverwrite` keeps the `overwrite` field if needed.
 *   `onScopeBlocked` is invoked when a narrower-scope follow is blocked by a
 *   schema scope cap (the chain then terminates at an undefined-data link);
 *   it is the only way to distinguish that cut from a chain that genuinely
 *   ends at a stored undefined-data link.
 * @returns The resolved link.
 */
export function resolveLink(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  lastNode: LastNode = "value",
  options: { preserveOverwrite?: boolean; onScopeBlocked?: () => void } = {},
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
    // If not a sigil link, use that error's path to check the parent once.
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
        depth: link.path.length,
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

        // A full-path candidate needs no further check: the sigil probe above
        // already covered it, and `$alias` records in data are not links.
        if (lastValid.length < link.path.length) {
          // Check sigil at this parent
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
              depth: lastValid.length,
            };
          }
        }

        if (nextHop) {
          const remainingPath = link.path.slice(lastValid.length);
          let { schema, ...restLink } = nextHop.link;
          if (schema !== undefined && remainingPath.length > 0) {
            schema = ContextualFlowControl.getSchemaAtPath(
              schema,
              remainingPath,
            );
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
      if (!canFollowLinkHop(link, nextHop)) {
        // Blocked narrower-scope follow during link resolution — resolves to
        // undefined silently. Warn (not info) so the drop is observable; see
        // the matching site in traverse.ts followPointer (CT-1642).
        const schemaScope = schemaScopeForLinkAtDepth(link, nextHop.depth);
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
        options.onScopeBlocked?.();
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
      // The hop consumed `nextHop.depth` of our path and re-rooted the rest
      // under the target. Caps recorded for the consumed prefix have done
      // their job; caps for the REMAINING segments still have to travel, or a
      // capped handle below an already-followed link goes unchecked -- the
      // shape you get whenever a cell's root value is a link. `nextHop.link`
      // comes from `parseLink` and carries no caps of its own, so rebasing is
      // just a shift onto the target's path.
      const carriedCaps = rebaseScopeCaps(
        link.scopeCaps,
        nextHop.depth,
        // A cap at old depth k lands at (target base length) + (k - depth).
        // target base length = nextHop.link.path.length - (path.length - depth),
        // so the shift reduces to target-path length minus our own.
        nextHop.link.path.length - link.path.length,
      );
      if (nextLink.schema === undefined && link.schema !== undefined) {
        link = {
          ...nextLink,
          schema: link.schema,
          ...(carriedCaps !== undefined && { scopeCaps: carriedCaps }),
        };
      } else {
        link = carriedCaps === undefined
          ? nextLink
          : { ...nextLink, scopeCaps: carriedCaps };
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
    maybeSigilPayload !== undefined &&
    (!onlyWriteRedirects ||
      (maybeSigilPayload as CellLinkRefPayload).overwrite === "redirect")
  ) {
    return parseLink(readSubPath([]) as CellLink, link);
  } else {
    return undefined;
  }
}
