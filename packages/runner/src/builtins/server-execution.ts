import type { NormalizedFullLink } from "../link-utils.ts";

/**
 * Builtins whose external work has a server-side implementation in the first
 * server-primary rollout. Keep this list deliberately exact: a raw module only
 * receives this identity when it was resolved through the canonical builtin
 * registry ref, never from caller-controlled debug metadata.
 */
export const SERVER_EXECUTABLE_BUILTIN_IDS = [
  "fetchBinary",
  "fetchText",
  "fetchJson",
  "fetchJsonUnchecked",
  "fetchProgram",
  // The three LLM builtins share one broker route: `executeWithToolsLoop` →
  // `llmClientOptions` → `runtime.fetchBuiltin(<id>, "/api/ai/llm", …)`. Each
  // passes its own id so the host egress classifier and the per-builtin
  // channel keep them distinct.
  "llm",
  "generateText",
  "generateObject",
  // `llmDialog` dials the same `/api/ai/llm` broker route, through the same
  // `llmClientOptions`. Its trigger is what makes it server-executable at all:
  // the dialog turn starts from DOCUMENT state (`result.pending` plus
  // `internal.requestId`), not from the `addMessage` handler's process, so the
  // peer that appends a user message need not be the peer that egresses —
  // which is exactly what "handlers stay client-side, the dialog runs
  // server-side" requires.
  "llmDialog",
] as const;

export type ServerExecutableBuiltinId =
  typeof SERVER_EXECUTABLE_BUILTIN_IDS[number];

const SERVER_EXECUTABLE_BUILTIN_SET = new Set<string>(
  SERVER_EXECUTABLE_BUILTIN_IDS,
);

export function isServerExecutableBuiltinId(
  value: unknown,
): value is ServerExecutableBuiltinId {
  return typeof value === "string" &&
    SERVER_EXECUTABLE_BUILTIN_SET.has(value);
}

export function serverBuiltinImplementationHash(
  id: ServerExecutableBuiltinId,
): string {
  return `cf:builtin/${id}:server-v1`;
}

/**
 * Static implementation identity for a canonical builtin resolved through the
 * registry ref. Raw builtins are host functions with no SES provenance, so
 * `applyImplementationHash` cannot stamp them; without this their fingerprint
 * falls to an `action:…` shape that servability rejects as
 * `untrusted-implementation`. The `:v1` shape is deliberately distinct from
 * `serverBuiltinImplementationHash`'s `:server-v1`: identity ("this action IS
 * canonical builtin <id>") must never be conflated with "the server has a
 * native implementation of this external effect" — run.ts keys its
 * server-builtin effect-descriptor path on the exact `:server-v1` fingerprint.
 * The caller supplies the id ONLY from the canonical registry ref, never from
 * caller-controlled debug metadata.
 */
export function builtinImplementationHash(id: string): string {
  return `cf:builtin/${id}:v1`;
}

/** Runner-authored static portion of a supported builtin's action surface. */
export interface ServerBuiltinActionDescriptor {
  readonly version: 1;
  readonly id: ServerExecutableBuiltinId;
  readonly piece: NormalizedFullLink;
  readonly reads: readonly NormalizedFullLink[];
  readonly writes: readonly NormalizedFullLink[];
  /** Stable array populated by the builtin when it mints internal cells. */
  readonly runtimeWrites: readonly NormalizedFullLink[];
  readonly directOutputs: readonly NormalizedFullLink[];
}

/**
 * Builtins whose whole action surface is a single direct root output over their
 * registered inputs (W2.15a): each reads its inputs and writes exactly the one
 * minted result document plus the output spot that links to it. Verified
 * against `if-else.ts`, `when.ts`, `unless.ts` (each `setRawUntyped`s the single
 * result and nothing else) and `inspect-conf-label.ts` (mints
 * `{ inspectConfLabel: cause }` with a bare `runtime.getCell`, `sendResult`s a
 * link to it, `set`s the outcome into it; the metadata consultation
 * `inspectStoredConfLabel` only READS the target's `["cfc"]` subtree).
 *
 * `wish` joins them (R13, owner ruling 2026-07-29). Its measured surface IS
 * this shape: a resolving run writes exactly the minted
 * `{ wish: { state: cause } }` state document and the output spot linking to
 * it; a freeform run writes only the output spot. The reason it was refused a
 * descriptor before (a69aec5f9) was never the write surface — it was that
 * `wish` egresses UNBROKERED for its sidecar patterns, so certifying the
 * narrow surface would let both sides perform that egress. The owner ruled
 * that acceptable: the egress is an idempotent GET of a system pattern from
 * our own API (`patternUrl()` in `wish.ts`), so doubling it is harmless, and
 * D11 makes closing the serving gap the priority. What the descriptor does not
 * cover stays uncovered and fails closed: the sidecars' own transactions, the
 * mid-run `runtime.scheduler.subscribe`, and the user-scoped instance a
 * home-space target lands the state document at (admitted only under a scoped
 * lane, via the §4 `laneInstanceCovers` relaxation).
 *
 * Keep this registry deliberately exact, exactly like
 * `SERVER_EXECUTABLE_BUILTIN_IDS`: map/filter/flatMap carry output-collection
 * envelopes, so they are a separately-designed follow-up (W2.16) and must NOT
 * be added here. Membership is load-bearing beyond the descriptor: the runner
 * re-derives each member's minted result document through
 * `selectorBuiltinResultCause`, so an id added here whose builtin keys its mint
 * on a different cause gets a write surface naming a document it never writes —
 * and de-claims fail-closed on every run.
 *
 * The rest of the R5 worklist was audited against this shape and REJECTED:
 *  - `llmDialog` and `navigateTo` return `{ isEffect: true }` from their
 *    builtin factories, so the runner's `module.isEffect ?? builtinIsEffect`
 *    makes them EFFECT nodes whatever `index.ts` says. A computation
 *    descriptor cannot serve them —
 *    `serverBuiltinComputationScopeSummary` requires
 *    `actionKind === "computation"`, so the descriptor would never assemble.
 *    (`navigateTo` also enqueues a post-commit `navigateTo` effect through
 *    `runtime.navigateCallback`.) `llmDialog` took the EFFECT route instead
 *    and is now in `SERVER_EXECUTABLE_BUILTIN_IDS`: its four-document write
 *    surface — the three it mints (result / internal / pinnedCells) plus the
 *    `messages` transcript it appends model turns back into — rides
 *    `serverBuiltinRuntimeWrites`, which the computation descriptor has no
 *    field for. That asymmetry is the practical reason the effect route was
 *    the only one available, independent of the `actionKind` gate.
 *  - `compileAndRun` mints FOUR documents (`compile.pending|result|error|
 *    errors`), then `runtime.runner.stop` / `runtime.runSynced` a whole
 *    compiled pattern under the result doc and writes from async
 *    `editWithRetry` transactions outside its own run: unbounded, and not even
 *    envelope-shaped.
 *  - `sqliteDatabase` mints its handle through `makeResultCell`, which writes
 *    a document-root `["result"]` META path beside the `["value"]` payload —
 *    outside a value-root computation envelope, since only the MATERIALIZER
 *    summary lifts to document root (FB19/CA6), and that lift cannot be
 *    applied blanket here because the same descriptor declares the direct
 *    OUTPUT SPOT at link path `[]` too. Measured and pinned in
 *    `sqlite-database-servability.test.ts`; giving it an envelope needs a
 *    registry decision (join the materializer family, or grow a
 *    minted-document envelope field on the computation descriptor) that
 *    nobody has made. Its OTHER blocker is gone: since the 2026-07-29 owner
 *    ruling the db `owner` comes from the acting execution lane
 *    (`actingHandleOwner` in `sqlite-builtins.ts`), not the ambient
 *    `trustSnapshotProvider()`, so a server-side first run no longer mints
 *    the handle owned by the executor's lease principal.
 */
export const SERVER_COMPUTATION_BUILTIN_IDS = [
  "ifElse",
  "when",
  "unless",
  "inspectConfLabel",
  "wish",
] as const;

export type ServerComputationBuiltinId =
  typeof SERVER_COMPUTATION_BUILTIN_IDS[number];

const SERVER_COMPUTATION_BUILTIN_SET = new Set<string>(
  SERVER_COMPUTATION_BUILTIN_IDS,
);

export function isServerComputationBuiltinId(
  value: unknown,
): value is ServerComputationBuiltinId {
  return typeof value === "string" &&
    SERVER_COMPUTATION_BUILTIN_SET.has(value);
}

/**
 * Runner-authored static surface for a pure selector builtin. Unlike the effect
 * descriptor, there are no `runtimeWrites`: the write surface is exactly the
 * single direct output, and the assembled summary is fail-closed (observed
 * runtime writes are never folded into the envelope).
 */
export interface ServerBuiltinComputationDescriptor {
  readonly version: 1;
  readonly id: ServerComputationBuiltinId;
  readonly piece: NormalizedFullLink;
  readonly reads: readonly NormalizedFullLink[];
  readonly writes: readonly NormalizedFullLink[];
  readonly directOutputs: readonly NormalizedFullLink[];
}

/**
 * List builtins whose write surface is envelope-shaped: map/filter/flatMap each
 * mint a result CONTAINER document (the output collection) distinct from their
 * direct output and write the whole array plus per-slot element links into it
 * (W2.16). The per-element child sub-patterns are separate provenance-covered
 * actions, NOT this node's writes, so they are deliberately outside the
 * envelope — a first reconcile that instantiates children de-claims fail-closed
 * for that run and the client handles it, exactly like any other
 * dynamic-write-outside-static-surface. Keep this registry deliberately exact
 * (mirrors `SERVER_EXECUTABLE_BUILTIN_IDS`): only the three container-minting
 * list builtins belong; the pure selectors carry an exact single-output surface
 * (`SERVER_COMPUTATION_BUILTIN_IDS`) and `wish` is a resolver.
 */
export const SERVER_MATERIALIZER_BUILTIN_IDS = [
  "map",
  "filter",
  "flatMap",
] as const;

export type ServerMaterializerBuiltinId =
  typeof SERVER_MATERIALIZER_BUILTIN_IDS[number];

const SERVER_MATERIALIZER_BUILTIN_SET = new Set<string>(
  SERVER_MATERIALIZER_BUILTIN_IDS,
);

export function isServerMaterializerBuiltinId(
  value: unknown,
): value is ServerMaterializerBuiltinId {
  return typeof value === "string" &&
    SERVER_MATERIALIZER_BUILTIN_SET.has(value);
}

/**
 * Runner-authored static surface for a container-minting list builtin. Unlike
 * the pure selector descriptor, the write surface is an ENVELOPE
 * (`materializerWriteEnvelopes`, a root prefix over the result container) plus
 * the direct output — a checkable, fail-closed bound honest for a data-dependent
 * writer whose per-element slot count changes with the input list. The
 * envelope is re-derived from the resolved output cells each registration
 * (`instantiateRawNode`); the container identity is stable across list length,
 * so it never widens, but a run writing anywhere else de-claims at the firewall.
 */
export interface ServerBuiltinMaterializerDescriptor {
  readonly version: 1;
  readonly id: ServerMaterializerBuiltinId;
  readonly piece: NormalizedFullLink;
  readonly reads: readonly NormalizedFullLink[];
  readonly writes: readonly NormalizedFullLink[];
  readonly directOutputs: readonly NormalizedFullLink[];
  readonly materializerWriteEnvelopes: readonly NormalizedFullLink[];
}
