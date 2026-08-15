import type { DID } from "@commonfabric/identity";
import {
  type Cell,
  createBuilder,
  isCell,
  isStream,
  type JSONSchema,
  type MemorySpace,
  type Runtime,
} from "@commonfabric/runner";
import {
  type CellSelection,
  CellSelectionError,
  deriveSelectedValue,
} from "./cell-selection.ts";
import { loadPieces, type SpaceConfig } from "./piece.ts";
import { throwOnSpaceAuthorizationError } from "./utils.ts";

/**
 * The blessed, headless read path for wish targets (CT-1834).
 *
 * A wish target — `#profile`, the profile scalars (`#profileName`,
 * `#profileAvatar`, `#profileBio`, `#profileSpace`), or any other well-known
 * target — is resolved through the SAME runner builtin the runtime uses
 * (`packages/runner/src/builtins/wish.ts`), driven with `headless: true` so the
 * suggestion/picker UI patterns never spin up. Resolution (default → MRU →
 * first, runtime-enforced labels at read time) lives entirely in that builtin;
 * this helper never re-implements it. That is the whole point: consumers that
 * "cannot wish" (offline caches demoting to witness/echo, agents, scripts) get
 * one blessed read instead of hand-rolling profile resolution over raw
 * home-schemas fields — the mistake that broke when #4415 changed semantics.
 */
export interface WishReadConfig extends SpaceConfig {
  /** Wish target, e.g. "#profile" or "#profileName". */
  query: string;
  /** Extra path segments appended to the resolved target cell. */
  path?: string[];
  /** Optional result JSON schema (shapes/labels the projected value). */
  schema?: JSONSchema;
  /**
   * Search scope for hashtag queries: "~" (favorites/home), "." (mentionables /
   * current space), "profile" (profile elements), or arbitrary space DIDs.
   */
  scope?: (DID | "~" | "." | "profile")[];
  /** `--filter`/`--select`/`--schema`: the shape the caller asked the resolved
   * target to arrive in, read through the same step every other arrival reads
   * through. See {@link WishSpec.selection} for where it applies. */
  selection?: CellSelection;
}

export interface WishReadResult {
  /** The resolved value (dereferenced), or null when the wish produced none. */
  result: unknown;
  /** The error message a failed wish surfaced, if any (e.g. no profile yet). */
  error?: string;
}

/** The subset of {@link WishReadConfig} that describes the wish itself. */
export interface WishSpec {
  query: string;
  path?: string[];
  schema?: JSONSchema;
  scope?: (DID | "~" | "." | "profile")[];
  /**
   * The caller's `--filter`/`--select`/`--schema`, applied to the cell the
   * wish resolved to.
   *
   * It is answered against that live cell, which is what puts it BEFORE
   * {@link projectWishValue}: an address marker reads its answer off a cell,
   * and the walk that strips handles leaves nothing to read one from. The two
   * are not alternatives — the selection decides what comes back, the walk
   * decides how what remains is written down.
   */
  selection?: CellSelection;
}

/**
 * Resolve a wish target headlessly against an already-constructed runtime.
 *
 * Runs a trusted, inline single-node pattern — `() => ({ out: wish({ query,
 * path, scope, headless: true }, schema) })` (labels are enforced against
 * `runtime.userIdentityDID`), waits for the wish action and cross-space profile
 * loads to settle, then reads `out.result`. `#profile` / the profile scalars
 * resolve against the reading identity's home space regardless of `space`.
 *
 * Split out from {@link readWish} so it can be exercised against an emulated
 * runtime in unit tests without a live server.
 */
export async function resolveWish(
  runtime: Runtime,
  space: MemorySpace,
  spec: WishSpec,
): Promise<WishReadResult> {
  const { commonfabric } = createBuilder({
    unsafeHostTrust: runtime.createUnsafeHostTrust({
      reason: "cf wish headless read (CT-1834)",
    }),
  });
  const { wish, pattern } = commonfabric;

  const wishPattern = pattern(() => ({
    out: spec.schema
      ? wish(
        {
          query: spec.query,
          path: spec.path,
          scope: spec.scope,
          headless: true,
        },
        spec.schema,
      )
      : wish({
        query: spec.query,
        path: spec.path,
        scope: spec.scope,
        headless: true,
      }),
  }));

  const tx = runtime.edit();
  const resultCell = runtime.getCell<{
    out?: { result?: unknown; error?: unknown };
  }>(space, { wish: { headlessRead: spec.query } }, undefined, tx);
  const result = runtime.run(tx, wishPattern, {}, resultCell);
  await tx.commit();

  // Let the wish action run, then converge cross-space profile loads. The wish
  // builtin pulls freshly-created profiles across space boundaries and re-runs
  // when they materialize; pulling the result and syncing storage drains that.
  await result.pull();
  await runtime.idle();
  await runtime.storageManager.synced();
  // Surface a permanent authorization denial on the wish's own space with the
  // real error. Scoped to `space`: a denied cross-space profile load stays a
  // silent absent read, which is the wish's expected "no profile yet" outcome.
  throwOnSpaceAuthorizationError(runtime.storageManager, space);
  await result.pull();
  await runtime.idle();

  const outCell = result.key("out");
  const error: unknown = outCell.key("error").get();
  const resolved = outCell.key("result");
  const value: unknown = resolved.get();

  return {
    result: value === undefined
      ? null
      : await selectWishValue(runtime, space, resolved, value, spec),
    error: typeof error === "string" && error.length > 0 ? error : undefined,
  };
}

/**
 * Helper for {@link resolveWish}: `value` shaped the way the caller asked, or
 * `value` itself where they asked for nothing.
 *
 * The selection is answered against `resolved` — the live cell the wish landed
 * on — rather than against `value`, which is what lets an address marker
 * answer at all and what puts the whole step ahead of
 * {@link projectWishValue}.
 *
 * A wish that matched nothing has no cell to shape and never reaches here: an
 * absent target is an ordinary outcome of a query, and a selection must not
 * turn it into an error. A selection that materializes nothing over a target
 * that DID resolve is refused rather than reported as an absent target, on the
 * same grounds `cf piece get` and `cf piece call` refuse it — "the wish
 * matched nothing" and "your projection kept nothing" are different facts.
 */
async function selectWishValue(
  runtime: Runtime,
  space: MemorySpace,
  resolved: Cell<unknown>,
  value: unknown,
  spec: WishSpec,
): Promise<unknown> {
  if (spec.selection === undefined) return value;
  const selected = await deriveSelectedValue(
    runtime,
    space,
    resolved,
    spec.selection,
  );
  if (selected === undefined) {
    throw new CellSelectionError(
      `Cannot shape the result of wish "${spec.query}": the filter/schema ` +
        "expression did not materialize a JSON-renderable value. This is " +
        "not JSON null, and it is not the empty result of a wish that " +
        "matched nothing — inspect the target and the selection.",
    );
  }
  return selected;
}

/** What {@link readWish} needs from a connected pieces controller. */
export interface WishRuntimeHost {
  runtime: Runtime;
  getSpace(): MemorySpace;
}

/** Injectable connection dep, mirroring lib/piece.ts's `RootPatternDeps`. */
export interface ReadWishDeps {
  loadPieces?: (config: SpaceConfig) => Promise<WishRuntimeHost>;
}

/**
 * The blessed, headless read: connect a real identity/session-backed runtime via
 * {@link loadPieces}, then {@link resolveWish}. See {@link WishReadConfig}.
 */
export async function readWish(
  config: WishReadConfig,
  deps: ReadWishDeps = {},
): Promise<WishReadResult> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  return await resolveWish(pieces.runtime, pieces.getSpace(), {
    query: config.query,
    path: config.path,
    schema: config.schema,
    scope: config.scope,
    selection: config.selection,
  });
}

/** Base marker substituted for a stream/handle-valued node in projected output. */
export const WISH_STREAM_MARKER = "[stream]";

/** Marker for a stripped handle, optionally tagged with the key it hung off. */
function streamMarker(key?: string): string {
  return key === undefined ? WISH_STREAM_MARKER : `[stream:${key}]`;
}

/**
 * Project a resolved wish value to plain, serializable data for output (CT-1844).
 *
 * A `#profile` object result is a materialized pattern result: alongside the
 * data fields (`$NAME`, `name`, `avatar`, `bio`, `elements`, `isEditing`, …) it
 * carries the pattern's stream handles (`addElement`, `setName`, `setAvatar`,
 * …). Those handles are live `Cell`/`Stream` objects; JSON-serializing them
 * drags in the entire runtime object graph (scheduler, circular refs) — ~50KB
 * of noise that defeats the agent/script/offline-cache audience this read path
 * exists for.
 *
 * This walks the value and replaces every stream/cell/function-valued node with
 * a `[stream]` / `[stream:<key>]` marker, keeping all plain data (including
 * nested arrays like `elements` and the `$UI` VNode tree) intact. Scalar results
 * (a bare string/number/etc. from `#profileName` and friends) pass straight
 * through unchanged, so only the object-target output shape is affected.
 *
 * The walk memoizes the PROJECTED result per input node in a `Map` (with an
 * in-progress sentinel so genuine cycles terminate rather than recurse forever).
 * That is load-bearing correctness, not just efficiency: a plain object reached
 * by two different paths (a DAG "diamond") must be projected on BOTH — a bare
 * "already seen → return raw" dedup would leak any handle nested under the
 * shared subtree on the second path, re-exposing exactly the graph this strips.
 */
export function projectWishValue(value: unknown): unknown {
  return projectNode(value, undefined, new Map<object, unknown>());
}

/** In-progress sentinel: a node currently being projected higher in the stack. */
const IN_PROGRESS = Symbol("wish-projection-in-progress");

function projectNode(
  value: unknown,
  key: string | undefined,
  memo: Map<object, unknown>,
): unknown {
  if (isCell(value) || isStream(value) || typeof value === "function") {
    return streamMarker(key);
  }
  if (value === null || typeof value !== "object") return value;

  // TODO(danfuzz): the `typeof` gate admits a `FabricSpecialObject`, so the
  // `Object.entries` rebuild below renders one — a `FabricBytes` in a
  // materialized wish result, which the binary fetch builtin mints today —
  // as `{}` in the projected output. Wants a `FabricSpecialObject` test
  // returning the value whole, plus a fabric-aware rendering in the
  // downstream `render()`/`safeStringify` step, whose own marker in
  // `render.ts` predates this traffic and calls the path latent.
  const cached = memo.get(value);
  if (cached === IN_PROGRESS) {
    // A genuine cycle: this node is an ancestor of itself. Break it so the walk
    // terminates; downstream stringify would otherwise flag the same loop.
    return "[circular]";
  }
  if (cached !== undefined) return cached; // diamond: reuse the SAME projection.

  memo.set(value, IN_PROGRESS);
  const projected: unknown = Array.isArray(value)
    ? value.map((item, i) => projectNode(item, String(i), memo))
    : Object.fromEntries(
      Object.entries(value).map((
        [k, val],
      ) => [k, projectNode(val, k, memo)]),
    );
  memo.set(value, projected);
  return projected;
}
