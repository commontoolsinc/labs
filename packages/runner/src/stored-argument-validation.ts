/** Validates stored arguments without treating unreadable links as invalid values. */

import type { FabricValue } from "@commonfabric/data-model";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { JSONSchema } from "./builder/types.ts";
import type { Cell } from "./cell.ts";
import { validateSchemaValue } from "./cfc/schema-sanitization.ts";
import {
  type CellLink,
  isCellLink,
  type NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import {
  mergeSchemaDefaults,
  schemaAcceptsOpaqueCellValue,
} from "./runner-utils.ts";
import { ignoreReadForScheduling } from "./scheduler.ts";
import {
  type IExtendedStorageTransaction,
  type IReadOptions,
  toThrowable,
} from "./storage/interface.ts";

// An unreadable stored link has a value owned elsewhere. Its type is checked
// when reactive reads materialize it, rather than against a replica's absence.
const UNRESOLVED_LINK_PLACEHOLDER = Object.freeze({
  "unresolved cell link": true,
});

const acceptsOpaqueCellOrUnresolvedLink = (
  value: unknown,
  schema: JSONSchema,
): boolean =>
  value === UNRESOLVED_LINK_PLACEHOLDER ||
  schemaAcceptsOpaqueCellValue(value, schema);

const READ_NON_RECURSIVE: IReadOptions = { nonRecursive: true };

/** Per-validation traversal state for the unreadable-link overlay. */
interface LinkOverlayContext {
  /** Link addresses on the current descent. */
  chain: Set<string>;

  /** Completed overlays keyed by resolved address and materialized value. */
  results: Map<string, Map<unknown, unknown>>;

  /** Reads whose result depends on a recursion cutoff or unavailable value. */
  incompleteReads: number;
}

/**
 * Resolves one stored link — and any links it chains through — to the RAW
 * value tree at its endpoint, reading doc bytes through `tx`. `value` is
 * `undefined` whenever no readable tree is there: an absent doc, a doc
 * record holding no value (what a meta-only write leaves behind), a path the
 * present tree does not hold, a chain that cycles. The caller draws no
 * distinction among those — this walk exists to mirror the structure the
 * materialization resolved, not to judge absences, and which of them a raw
 * read is looking at is not knowable here (a slot a pattern materializes
 * lazily reads exactly like one that never synced; the pattern-vintage gate
 * holds real stores of both).
 *
 * Steps hop by hop rather than calling link-resolution's resolver because
 * the caller needs the endpoint's raw tree to recurse into, and because a
 * raw read of a path that crosses a mid-doc link would descend into the
 * link sigil's own JSON — so path segments are walked in memory and links
 * met along the way are followed.
 *
 * `chain` carries the link addresses of the CURRENT descent; every key this
 * walk adds is removed on the way out, whichever exit is taken — sibling
 * slots routinely share targets (one profile linked from `profiles`, `mru`,
 * and `defaultProfile` at once), and a leftover key would misread the
 * second sibling as a cycle. The repeat-address guard is the walk's
 * termination backstop, and the reason it is exported: the staging
 * materialization happens to throw on the cyclic shapes reachable today
 * before any walk runs, so only a direct test can exercise termination.
 */
export function readStoredLinkChainRaw(
  tx: IExtendedStorageTransaction,
  startLink: NormalizedFullLink,
  chain: Set<string>,
): {
  value: unknown;
  base: NormalizedFullLink;
  /** Whether the result depends on a repeated address in the active chain. */
  cyclic?: true;
} {
  const added: string[] = [];
  const follow = (
    value: CellLink,
    base: NormalizedFullLink,
    rest: string[],
  ) => {
    const next = parseLink(value, base);
    const path = [...next.path, ...rest];
    const key = JSON.stringify([next.space, next.id, next.scope, path]);
    if (chain.has(key)) return undefined;
    chain.add(key);
    added.push(key);
    return { ...next, path };
  };
  try {
    let link = startLink;
    while (true) {
      const { ok, error } = tx.read(
        {
          space: link.space,
          id: link.id,
          scope: link.scope,
          type: "application/json",
          path: ["value"],
        },
        READ_NON_RECURSIVE,
      );
      if (error !== undefined) {
        // The same line readOrThrow draws: an absent document or a path
        // through a primitive reads as no value here, and every other
        // failure — a dead transaction, malformed storage — surfaces.
        if (
          error.name !== "NotFoundError" && error.name !== "TypeMismatchError"
        ) {
          throw toThrowable(error);
        }
        return { value: undefined, base: link };
      }
      if (ok.value === undefined) {
        return { value: undefined, base: link };
      }
      let value: unknown = ok.value;
      const path = [...link.path] as string[];
      let followed: NormalizedFullLink | undefined;
      while (path.length > 0) {
        if (isCellLink(value)) {
          // A link met mid-path: the rest of the path applies at its target.
          followed = follow(value, link, path);
          if (followed === undefined) {
            return { value: undefined, base: link, cyclic: true };
          }
          break;
        }
        if (!isObjectOrArray(value)) {
          return { value: undefined, base: link };
        }
        value = (value as Record<string, unknown>)[path.shift()!];
      }
      if (followed === undefined && isCellLink(value)) {
        followed = follow(value, link, []);
        if (followed === undefined) {
          return { value: undefined, base: link, cyclic: true };
        }
      }
      if (followed !== undefined) {
        link = followed;
        continue;
      }
      return { value, base: link };
    }
  } finally {
    for (const key of added) chain.delete(key);
  }
}

/**
 * Rebuilds `materialized` so every slot whose STORED value routes through a
 * link and materialized to `undefined` carries
 * {@link UNRESOLVED_LINK_PLACEHOLDER} instead. Behind a link, an absence
 * defers, whatever produced it: the value is owned elsewhere, and "not
 * replicated here yet" reads identically to "not materialized yet" — the
 * pattern-vintage gate holds real stores where the same missing slot is
 * each of those. A slot that materialized to a VALUE is never touched, so a
 * readable wrong-typed value still refuses; and an `undefined` stored
 * literally in the argument doc itself — no link involved — still judges,
 * so a doc that plainly holds nothing keeps failing a required check. A
 * deferred slot's schema check still happens, at instantiation-time
 * reactive reads (the same verdict link-resolution's `pendingHopDoc`
 * renders for lazy reads).
 *
 * The walk mirrors the materialization it repairs: from the argument doc's
 * raw bytes, following every link — across docs and spaces, to any depth —
 * via {@link readStoredLinkChainRaw}. Stored links distinguish an unreadable
 * target from a literal absence in the already-defaulted materialized view.
 * Completed subgraphs are reused by address and view within this validation;
 * a result affected by a recursion cutoff or unavailable raw-chain read stays
 * local to its descent. Shared acyclic subgraphs avoid repeated expansion,
 * while cyclic graphs retain their path-dependent cutoff behavior.
 *
 * The caller supplies an already-materialized snapshot. Exported from this
 * module for direct cycle tests: eager materialization can reject a cyclic
 * graph before this walk gets to exercise its own termination guards.
 */
export function overlayUnreadableLinkPlaceholders(
  tx: IExtendedStorageTransaction,
  base: NormalizedFullLink,
  raw: unknown,
  materialized: unknown,
): unknown {
  return overlayUnreadableLinkPlaceholdersInternal(
    tx,
    base,
    raw,
    materialized,
    { chain: new Set(), results: new Map(), incompleteReads: 0 },
  );
}

/** Helper for `overlayUnreadableLinkPlaceholders()`, which tracks one descent. */
function overlayUnreadableLinkPlaceholdersInternal(
  tx: IExtendedStorageTransaction,
  base: NormalizedFullLink,
  raw: unknown,
  materialized: unknown,
  context: LinkOverlayContext,
): unknown {
  if (isCellLink(raw)) {
    if (materialized === undefined) return UNRESOLVED_LINK_PLACEHOLDER;
    const link = parseLink(raw, base);
    const key = JSON.stringify([link.space, link.id, link.scope, link.path]);
    if (context.chain.has(key)) {
      context.incompleteReads++;
      return materialized;
    }
    // Resolve relative links before indexing, and keep separately defaulted
    // views of the same endpoint distinct. Reusing the whole completed walk
    // bounds both reads and traversal work on shared acyclic linked graphs.
    let byValue = context.results.get(key);
    if (byValue?.has(materialized)) return byValue.get(materialized);
    if (byValue === undefined) {
      byValue = new Map();
      context.results.set(key, byValue);
    }
    const incompleteBefore = context.incompleteReads;
    context.chain.add(key);
    try {
      const reading = readStoredLinkChainRaw(tx, link, context.chain);
      if (reading.value === undefined) {
        // A raw chain can stop at an active ancestor or unavailable value.
        // Its result and every enclosing result stay local to this descent.
        context.incompleteReads++;
        return materialized;
      }
      const result = overlayUnreadableLinkPlaceholdersInternal(
        tx,
        reading.base,
        reading.value,
        materialized,
        context,
      );
      // A back edge leaves an ancestor's materialized value in place. That
      // partial result depends on this descent and cannot serve a sibling.
      if (incompleteBefore === context.incompleteReads) {
        byValue.set(materialized, result);
      }
      return result;
    } finally {
      context.chain.delete(key);
    }
  }
  if (Array.isArray(raw) && Array.isArray(materialized)) {
    let result: unknown[] | undefined;
    for (let i = 0; i < raw.length; i++) {
      const child = overlayUnreadableLinkPlaceholdersInternal(
        tx,
        base,
        raw[i],
        materialized[i],
        context,
      );
      if (child !== materialized[i]) {
        result ??= materialized.slice();
        result[i] = child;
      }
    }
    return result ?? materialized;
  }
  if (isObjectOrArray(raw) && isObjectOrArray(materialized)) {
    let result: Record<string, unknown> | undefined;
    for (const [key, rawChild] of Object.entries(raw)) {
      const child = overlayUnreadableLinkPlaceholdersInternal(
        tx,
        base,
        rawChild,
        (materialized as Record<string, unknown>)[key],
        context,
      );
      if (child !== (materialized as Record<string, unknown>)[key]) {
        result ??= { ...(materialized as Record<string, unknown>) };
        result[key] = child;
      }
    }
    return result ?? materialized;
  }
  return materialized;
}

/**
 * Returns a stored argument's schema mismatch, deferring unreadable linked slots.
 * Source preflight and runtime setup use the same defaults and absence rules.
 * The caller supplies the transaction so staged writes and read-only checks
 * validate the storage version they actually act on.
 */
export function storedArgumentValidationIssue(
  argumentCell: Cell<unknown>,
  argumentSchema: JSONSchema,
  defaults: FabricValue,
  tx: IExtendedStorageTransaction,
): string | undefined {
  const argumentLink = argumentCell.getAsNormalizedFullLink();
  const materializedArgument = argumentCell.asSchema(undefined).withTx(tx)
    .get();
  const validationArgument: unknown = mergeSchemaDefaults(
    materializedArgument,
    defaults,
    argumentSchema,
    { mergeMaterializedLinks: true },
  );
  const validationOptions = {
    acceptOpaqueValue: acceptsOpaqueCellOrUnresolvedLink,
    // An OPTIONAL key holding `undefined` carries no data, and a handler
    // mints one without meaning to: `comments.push({ author, ... })` with
    // no author in hand writes the key, and the codec stores that presence.
    // Measuring it here asks whether `undefined` satisfies the property's
    // declared type, which nothing ordinary answers yes to — and THIS
    // refusal is permanent, because the same identity refuses identically
    // (see `isStoredArgumentSchemaRefusal`). A pattern would be unable to
    // update documents it wrote itself. Measured on `topics/topic.tsx`
    // (`author`) and `lunch-poll/main.tsx` (`imageUrl`).
    //
    // Scoped to THIS caller rather than made the validator's rule: writing
    // `undefined` where a number is declared is still a mistake worth
    // rejecting at a result write, while the caller can still see it.
    optionalUndefinedIsAbsent: true,
  };
  let validationFailure = validateSchemaValue(
    argumentSchema,
    validationArgument,
    argumentSchema,
    validationOptions,
  );
  if (validationFailure !== undefined) {
    // Judge only what this context can actually read. The materialization
    // above resolves the staged doc's whole link graph through this
    // transaction, and a link chain that dead-ends at a doc the local
    // replica cannot serve materializes as `undefined` — indistinguishable
    // from a stored mistake, though the stored bytes are fine and every
    // OTHER context may read them. Validating that `undefined` bricks the
    // piece permanently (same identity, same refusal — see
    // `isStoredArgumentSchemaRefusal`), so such slots validate as opaque
    // and their schema check is deferred to instantiation-time reactive
    // reads, which sync what they need. Supplied and re-staged arguments
    // alike: a caller vouches for the value it stages, but which link
    // targets happen to be replicated HERE was never part of that value.
    // The overlay only ever turns `undefined` into an accepted opaque, so
    // running it on failure alone changes no verdict — it spares the
    // happy path a second walk of the stored graph.
    validationFailure = validateSchemaValue(
      argumentSchema,
      overlayUnreadableLinkPlaceholders(
        tx,
        argumentLink,
        argumentCell.withTx(tx).getRaw({ meta: ignoreReadForScheduling }),
        validationArgument,
      ),
      argumentSchema,
      validationOptions,
    );
  }
  return validationFailure;
}
