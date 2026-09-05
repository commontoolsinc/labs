import type { Source } from "@commonfabric/js-compiler";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectOrArray } from "@commonfabric/utils/types";

import {
  brandTrustedPattern,
  getArtifactEntryRef,
  getPatternProgram,
  getPatternSourcePath,
  isKeylessPatternIdentity,
  isTrustedBuilderArtifact,
  isTrustedPattern,
  KEYLESS_PATTERN_IDENTITY_PREFIX,
  resolveOriginal,
  setArtifactEntryRef,
  setPatternProgram,
  setPatternSourcePath,
} from "./builder/pattern-metadata.ts";
import { Module, Pattern } from "./builder/types.ts";
import { readStoredCfcMetadata } from "./cfc/metadata.ts";
import type { CfcMetadata } from "./cfc/types.ts";
import { ColdLoadNegativeMemo } from "./cold-load-negative-memo.ts";
import {
  buildSourceDocs,
  COMPILED_INTEGRITY_ATOM,
  compiledDocKey,
  deriveModuleDelegations,
  getCompileCacheRuntimeVersion,
  loadCompiledClosure,
  loadVerifiedSourceClosure,
  type ModuleDelegationMap,
  moduleDelegationsFromDocs,
  planCompileCacheWriteChunks,
  ROOT_LINK_SPECIFIER,
  type SourceDoc,
  sourceDocKey,
  WRITE_TARGET_EDGE_SYNC_SCHEMA,
  writeSourceAndCompiledDocs,
  writeSourceDocs,
} from "./compilation-cache/cell-cache.ts";
import { createRef } from "./create-ref.ts";
import { interleaveCompileYield } from "./harness/compile-interleave.ts";
import {
  deterministicCompileError,
  isDeterministicCompileFailure,
} from "./harness/compile-failure.ts";
import { compilerStack } from "./harness/deferred-compiler-stack.ts";
import type {
  CacheableModule,
  CompiledModuleArtifact,
  EvaluateResult,
  Exports,
  TypeScriptHarnessProcessOptions,
} from "./harness/types.ts";
import { RuntimeProgram } from "./harness/types.ts";
import type { PatternCoverageCollector } from "./pattern-coverage.ts";
import type { MemorySpace, Runtime, ServerRunInfo } from "./runtime.ts";

/** The §2b delegated carriage a cross-space cache writeback rides (OW31
 * seat S-A): captured verbatim from the TRIGGERING run's wave context
 * (the provisioning handler / demanded run) at `replicatePatternToSpace`
 * and threaded to the writeback stamps, where it applies only to writes
 * FOREIGN to the serving manager's home space. */
export type WritebackDelegation = NonNullable<ServerRunInfo["delegated"]>;

/**
 * Writes a compiled closure back to a space's compile cache: the shape of
 * `PatternManager`'s own write-back, and of the writer a test supplies in
 * its place.
 */
export type CompileCacheWriter = (
  space: MemorySpace,
  modules: CacheableModule[],
  entryIdentity: string,
  opts: { runtimeVersion: string },
  moduleDelegations?: ModuleDelegationMap,
  delegated?: WritebackDelegation,
) => Promise<void>;

import {
  isFabricImportSpecifier,
  parseFabricRef,
  pinnedIdentity,
} from "./sandbox/fabric-import-specifier.ts";
import {
  type CachedCompiledModule,
  DATA_FILE_SPECIFIER,
  SOURCE_ROOT_SPECIFIER,
} from "./sandbox/module-record-compiler.ts";
import type {
  CommitError,
  IExtendedStorageTransaction,
} from "./storage/interface.ts";
import { fromURI, toURI } from "./uri-utils.ts";

const logger = getLogger("pattern-manager");

// Cap for `#parkedFailedReplications` (distinct WANTED identities with at
// least one parked failed replication). Parks only exist while a real
// supply failure is outstanding — a handful per session in every observed
// incident — so the cap is a safety net against a pathological session,
// not a working-set bound; eviction is loud (`closure-replication-park-
// evicted`) and costs at most one lost heal, never a wrong copy (the
// evicted failure already logged its one-shot `closure-replication-failed`
// line, exactly the pre-heal contract).
const MAX_PARKED_FAILED_REPLICATIONS = 64;

// Bound for the in-memory identity->module cache. Higher than the pattern cache
// because a single bundle contributes one entry per module (a big space-root
// bundle is ~10 modules), and entries are cheap (a reference to an already-live
// namespace).
const MAX_EVALUATED_MODULE_CACHE_SIZE = 1000;
const PATTERN_COVERAGE_CACHE_VARIANT = "pattern-coverage";

/**
 * The compiler's hoist namespace. `builder-call-hoisting` mints
 * `__cfPattern_<n>` (n counting from 1) for the anonymous sub-patterns it
 * derives, and registers them through `__cfReg` — never as exports.
 * Registration refuses an AUTHORED builder-artifact export under these names,
 * which is what lets everything downstream that must tell a derived hoist
 * from an authored artifact — the pattern-update gates among them — read
 * provenance from the spelling alone: a `__cfPattern_<n>` in the artifact
 * index can only be the transformer's.
 *
 * What is PROHIBITED here is deliberately wider than what the compiler
 * MINTS, and wider than what a consumer recognizes as a hoist (the gate's
 * `isDerivedHoistSymbol` matches `_1` upward, since that is what actually
 * gets emitted). `_0` and `_01` are minted by nothing, so reserving them
 * costs authors nothing real — and leaving them authorable would leave the
 * confusable spellings, the ones a reader cannot tell from a hoist at a
 * glance, as the only ones anybody could take. A prohibition may safely
 * exceed the convention it protects; a recognizer may not.
 */
const RESERVED_HOIST_EXPORT = /^__cfPattern_\d+$/;

/**
 * Throw if any module in an evaluated bundle exports a builder artifact in
 * the reserved hoist namespace.
 *
 * A whole-bundle pre-pass rather than a check inside the registration loop,
 * so a refused bundle registers nothing at all: a module rejected after its
 * neighbors were indexed would leave the session holding half a bundle.
 * Only artifacts are checked — `#indexArtifact` admits nothing else, so a
 * plain value under such a name can never be resolved as a hoist.
 */
function assertNoReservedHoistExports(
  exportsByIdentity: ReadonlyMap<string, Record<string, unknown>>,
): void {
  for (const [identity, exports] of exportsByIdentity) {
    for (const exportName of Object.keys(exports)) {
      if (
        RESERVED_HOIST_EXPORT.test(exportName) &&
        isTrustedBuilderArtifact(exports[exportName])
      ) {
        throw new Error(
          `module ${identity} exports the builder artifact ` +
            `"${exportName}": the __cfPattern_<n> names are the compiler's ` +
            `own hoist namespace, and an authored artifact under one reads ` +
            `as a derived hoist wherever provenance matters — export it ` +
            `under another name`,
        );
      }
    }
  }
}

/** Whether copying source bytes would discard a meaningful stored CFC label. */
export function sourceCfcMetadataProhibitsCrossSpaceCopy(
  metadata: CfcMetadata | undefined,
): boolean {
  return metadata?.labelMap.entries.some((entry) => {
    const confidentiality = entry.label.confidentiality ?? [];
    const integrity = entry.label.integrity ?? [];
    if (confidentiality.length > 0) return true;
    if (integrity.length === 0) return false;
    return entry.path.length !== 1 ||
      entry.path[0] !== "delegatedModuleIdentities" ||
      integrity.some((atom) => atom !== COMPILED_INTEGRITY_ATOM);
  }) ?? false;
}

function throwableStorageError(error: CommitError): Error {
  if (error instanceof Error) return error;
  return Object.assign(new Error(error.message), {
    name: error.name,
    cause: error,
  });
}

function moduleByteCacheRuntimeVersion(
  runtimeVersion: string | undefined,
  options: { patternCoverage: boolean },
): string | undefined {
  if (runtimeVersion === undefined) return undefined;
  return options.patternCoverage
    ? `${runtimeVersion}/${PATTERN_COVERAGE_CACHE_VARIANT}`
    : runtimeVersion;
}

function isPatternCoverageCacheRuntimeVersion(runtimeVersion: string): boolean {
  return runtimeVersion.endsWith(`/${PATTERN_COVERAGE_CACHE_VARIANT}`);
}

function compileCachePersistenceSlotKey(
  space: MemorySpace,
  entryIdentity: string,
  opts: { runtimeVersion: string },
): string {
  return JSON.stringify([space, opts.runtimeVersion, entryIdentity]);
}

function compileCacheClosureSignature(
  moduleIdentities: readonly string[],
  moduleDelegations: ModuleDelegationMap = new Map(),
): string {
  return JSON.stringify({
    modules: [...new Set(moduleIdentities)].sort(),
    delegations: [...moduleDelegations]
      .map(([identity, predecessors]) => [
        identity,
        [...predecessors].sort(),
      ])
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  });
}

function expectedSourceClosureIdentities(
  modules: readonly CacheableModule[],
  entryIdentity: string,
): Set<string> {
  const docs = buildSourceDocs(modules, entryIdentity);
  const reachable = new Set<string>();
  const pending = [entryIdentity];
  while (pending.length > 0) {
    const identity = pending.pop()!;
    if (reachable.has(identity)) continue;
    reachable.add(identity);
    for (const imp of docs.get(identity)?.imports ?? []) {
      pending.push(imp.identity);
    }
  }
  return reachable;
}

function closureIncludesModuleDelegations(
  docs: ReadonlyMap<
    string,
    { readonly delegatedModuleIdentities?: readonly string[] }
  >,
  required: ModuleDelegationMap,
): boolean {
  for (const [identity, predecessors] of required) {
    const stored = new Set(docs.get(identity)?.delegatedModuleIdentities ?? []);
    for (const predecessor of predecessors) {
      if (!stored.has(predecessor)) return false;
    }
  }
  return true;
}

function compileCacheRecoveryKey(
  space: MemorySpace,
  entryIdentity: string,
): string {
  return JSON.stringify([space, entryIdentity]);
}

function cacheEntriesIncludePatternCoverage(
  entries: Iterable<{ readonly patternCoverageSpans?: unknown }>,
): boolean {
  for (const entry of entries) {
    if (!Array.isArray(entry.patternCoverageSpans)) return false;
  }
  return true;
}

/**
 * Re-derive a stored module's fabric edges from its SOURCE text (source docs
 * deliberately do not store them as links). Unpinned specifiers are skipped:
 * they carry no target identity to link, and they cannot legitimately occur
 * here — the cell-cache write path refuses to persist modules with unpinned
 * fabric imports (`assertNoUnpinnedFabricImports`), so a skip only ever drops
 * an edge from data that predates that guard.
 */
function fabricImportRefsFromSource(
  doc: SourceDoc,
): CacheableModule["imports"] {
  // Deferred compiler stack (parses): source docs only reach this via
  // loadVerifiedSourceClosure, which awaits ensureCompilerStack().
  const { collectImportSpecifiers, ts } = compilerStack();
  const source: Source = { name: doc.filename, contents: doc.code };
  const refs: CacheableModule["imports"] = [];
  const seen = new Set<string>();
  for (
    const specifier of collectImportSpecifiers(
      source,
      ts.ScriptTarget.ES2023,
    )
  ) {
    if (!isFabricImportSpecifier(specifier)) continue;
    const ref = parseFabricRef(specifier);
    if (ref === undefined) continue;
    const targetIdentity = pinnedIdentity(ref);
    if (targetIdentity === undefined) continue;
    const key = `${specifier}\0${targetIdentity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ specifier, targetIdentity });
  }
  return refs;
}

function uniqueCacheableImports(
  imports: CacheableModule["imports"],
): CacheableModule["imports"] {
  const seen = new Set<string>();
  const out: CacheableModule["imports"] = [];
  for (const imp of imports) {
    const key = `${imp.specifier}\0${imp.targetIdentity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(imp);
  }
  return out;
}

/**
 * The authored filenames an entry document's source-package edges point at, for
 * one edge kind — {@link SOURCE_ROOT_SPECIFIER} for attached source entry
 * points, {@link DATA_FILE_SPECIFIER} for attached data files. An edge whose
 * target is not in the closure contributes nothing.
 */
function sourcePackagePaths(
  entry: { imports: readonly { specifier: string; identity: string }[] },
  docsByIdentity: ReadonlyMap<string, { filename: string }>,
  specifierPrefix: string,
): string[] {
  return entry.imports
    .filter((edge) => edge.specifier.startsWith(specifierPrefix))
    .map((edge) => docsByIdentity.get(edge.identity)?.filename)
    .filter((filename): filename is string => filename !== undefined);
}

/**
 * A closure-replication read failure whose remedy is SUPPLY: the wanted
 * identity's closure was readable in no space this manager can reach
 * (heuristic origin dry, fallback map dry or every candidate incomplete).
 * Carries the WANTED identity — the identity whose read failed, which for
 * a dependency-recursion frame is the DEPENDENCY's identity, not the
 * entry's (`replicateClosures` re-enters with it as `entryIdentity`) — so
 * the failure-registration site can park under the identity a future
 * supply record will name (the ruled 3b close; see
 * `#parkedFailedReplications`).
 *
 * The class deliberately does NOT set `this.name`: `String(error)` in the
 * `closure-replication-failed` line must stay `Error: <reason>` with the
 * production reason strings byte-identical — five direct-CI probe
 * classifications in the OW45 arc grep for exactly those lines.
 */
class ClosureReplicationSupplyError extends Error {
  constructor(reason: string, readonly wantedIdentity: string) {
    super(reason);
  }
}

/** One parked failed replication (see `#parkedFailedReplications`): enough
 * to re-issue the ENTRY's full replication — fresh ticket, fresh visited
 * set — when a matching supply records. `delegated` is the original §2b
 * carriage; the accept gate's delegated admission validates completeness,
 * not freshness (engine-wave-sink's protocol.md §2b row), so a late
 * re-issue is the same admission shape as the fire-and-forget original. */
type ParkedReplication = {
  entryIdentity: string;
  fromSpace: MemorySpace;
  toSpace: MemorySpace;
  delegated: WritebackDelegation | undefined;
};

export class PatternManager {
  // Single-flight dedup + in-memory result cache for `compileOrGetPattern`,
  // keyed by a content hash of the program (NOT a cell id, NOT the retired
  // patternId) so identical source returns one shared, already-compiled pattern
  // instance. The hash is computed with `createRef` purely as a stable digest
  // function — no `pattern:` cell is ever minted. Bounded FIFO to cap memory.
  readonly #inProgressCompilations = new Map<string, Promise<Pattern>>();
  // Single-flight dedup for the expensive tail of `loadPatternByIdentity`
  // (storage closure read + SES evaluation), keyed by `${space}\0${identity}`.
  // Boot references the same entry several times at once (one load per
  // referencing piece/system pattern); without this every concurrent miss ran
  // its own full closure evaluation — measured as 4 identical 9-module SES
  // evals per cold worker boot, the multiplier behind most of the per-module
  // boot-floor buckets. Followers await the leader and then resolve their own
  // symbol from the indexes the leader's evaluation populated — the same path
  // a load arriving after completion takes.
  readonly #inProgressByIdentityLoads = new Map<
    string,
    Promise<Pattern | undefined>
  >();
  // Session-local negative memo for compile failures that are deterministic
  // over a fully loaded, Merkle-verified source closure. Verification failure,
  // absent/incomplete storage, resolution, and evaluation remain retryable.
  // Keyed by `${space}\0${entryIdentity}` and runtimeVersion so a version bump
  // re-opens the attempt. Bounded FIFO to cap memory.
  #coldLoadNegativeMemo = new ColdLoadNegativeMemo();
  // Content-hash → { compiled pattern, the space its closure was first written
  // into }. The space is tracked so a cross-space cache hit can replicate the
  // source/compiled closure into the requested space (see compileOrGetPattern):
  // identical source dedupes the expensive TS compile, but every space holding
  // a piece that points at the pattern still needs the closure persisted there
  // to reload by { identity, symbol } in a fresh runtime.
  #compiledByContent = new Map<
    string,
    { pattern: Pattern; space?: MemorySpace }
  >();
  // The forward value → {identity, symbol} map lives module-level in
  // builder/pattern-metadata.ts (`setArtifactEntryRef`/`getArtifactEntryRef`)
  // so builder-layer copy sites can carry refs onto derived copies without a
  // PatternManager handle.
  // THE in-memory reverse index for content-addressed builder artifacts: module
  // identity -> (symbol -> live value). The single source for
  // `artifactFromIdentitySync` (the inverse of the forward `valueToEntryRef`),
  // populated by ONE path (`#indexArtifact`) from BOTH a module's `__cfReg`
  // registrations (hoists + non-exported top-level) AND its exports — so callers
  // never look in two places. SESSION-LIFETIME, deliberately unbounded (design
  // § Open questions 2, resolved): the sync resolution the list builtins and
  // refs-only pattern JSON depend on must never lose an artifact whose module
  // evaluated this session. Entries are live builder artifacts of evaluated
  // modules — the same order of retention the engine's strong implementation
  // index (E1) already committed to for their implementation functions.
  readonly #addressableByIdentity = new Map<string, Map<string, unknown>>();
  // Bound for the module-NAMESPACE cache below (`#modulesByIdentity`) only; its
  // misses recover through the async storage-backed load. Instance field so
  // tests can shrink it.
  #maxEvaluatedModuleCacheSize = MAX_EVALUATED_MODULE_CACHE_SIZE;

  // The writer a test supplies in place of the compile-cache write-back;
  // undefined means the manager's own.
  #compileCacheWriter: CompileCacheWriter | undefined = undefined;
  // ESM content-addressed compile-cache instrumentation.
  #esmCacheStats = { hits: 0, misses: 0, byIdentityHits: 0 };
  // In-memory identity -> module-namespace cache (CT-1623). Populated for EVERY
  // module of an evaluated ESM bundle (keyed by prefix-free content identity),
  // so a by-identity load of a sub-pattern reuses the already-live module from
  // its parent's bundle instead of re-reading the closure from storage and
  // re-evaluating it in SES. Content-addressed, so a hit is always the same
  // bytes — never stale. Bounded (FIFO) to cap memory.
  readonly #modulesByIdentity = new Map<string, { exports: Exports }>();
  // In-flight compiled-cache write-backs; awaited by flushCompileCacheWrites()
  // for graceful shutdown / deterministic tests. Cold compile write-backs are
  // awaited by compilePattern; recovery/replication paths may still run in the
  // background.
  readonly #compileCacheWrites = new Set<Promise<unknown>>();
  // Closure write-backs that replication must observe before reading its
  // origin space. Tracked separately because the replication promise also
  // lives in `#compileCacheWrites` and cannot await itself.
  readonly #pendingCacheWriteBacks = new Set<Promise<unknown>>();
  // In-flight replications keyed by TARGET space, ordered by a monotonic
  // ticket. A replication's origin may itself be mid-supply by an earlier
  // replication INTO it (e.g. the content-cache hit's fire-and-forget
  // sibling ahead of the runner's cross-space child replication in one
  // handler run); a one-shot origin read would then fail with nothing
  // ever re-issuing it, and the target space's demanded roots park
  // `pattern-unloadable` forever (verification-coverage.md OW45, the
  // lunch forever-park — the incident evidence lives there). The sibling
  // lives in `#compileCacheWrites`, the one set the origin read must NOT
  // await wholesale (it would await itself), so replications also
  // register HERE and the read awaits only the STRICTLY OLDER entries
  // targeting its origin — registration order keeps the await graph
  // acyclic (no from/to mutual wait), and genuine absence still throws
  // loudly after the awaited siblings settle.
  #replicationsIntoSpace = new Map<
    MemorySpace,
    Set<{ ticket: number; settled: Promise<unknown> }>
  >();
  #nextReplicationTicket = 0;
  // Spaces this manager DURABLY persisted an entry's closure into
  // (recorded at the two tracked persists' success; session-lifetime,
  // record-only — a later slot invalidation forces a re-verify on read,
  // and the fallback read below re-verifies fail-closed anyway, so a
  // stale record costs one failed read, never a wrong copy). These are
  // `replicateClosures`' FALLBACK ORIGINS: the caller-named origin is a
  // provenance heuristic — the in-memory artifact index serves patterns
  // with no per-space persist, so a running piece's space can lack the
  // closure entirely — while the closure is content-addressed, so any
  // recorded persist target holds byte-identical, integrity-gated docs
  // (verification-coverage.md OW45 carries the incident evidence).
  // Growth: monotonic for the session, bounded by the module identities ×
  // spaces this manager actually persisted (strings + small DID sets) —
  // negligible today; revisit with an eviction policy only if serving
  // sessions get very long-lived.
  #persistedClosureSpaces = new Map<string, Set<MemorySpace>>();
  // Failed replications PARKED for event-driven re-supply (the ruled 3b
  // close — verification-coverage.md OW45, RULING 2026-08-28: the one
  // supplier-timing geometry no await can see is a supplier that has not
  // STARTED by consult time, so the failure parks and the supply's own
  // RECORD re-issues it). Keyed by the WANTED identity — the identity
  // whose READ failed, which for a dependency-recursion frame is the
  // DEPENDENCY's identity, not the entry's: the dependency's supplier
  // records the dependency's own module identities, so an entry-keyed
  // registry would miss exactly that record event. The inner map keys by
  // (entry, from, to) so a re-registration after a failed re-issue
  // REPLACES its predecessor instead of accumulating. Entries drop at
  // wake time — one wake per matching persist event; a re-issue that
  // fails again re-parks and waits for the NEXT record, so there is no
  // self-clocking loop — and otherwise die with the session. Growth:
  // FIFO-capped at MAX_PARKED_FAILED_REPLICATIONS wanted keys (loud
  // eviction); a stale park costs one wasted loud re-issue on a matching
  // record, never a wrong copy (the re-issue re-runs the full verified,
  // fail-closed read). The cap bounds WANTED KEYS only — the inner
  // (entry, from, to) map is deliberately not capped in its own right
  // (cubic PM-2 on #6528, adjudicated LOW): filling one takes that many
  // DISTINCT real supply failures for a single identity, each carrying
  // its own loud failure + park line, and ONE matching record wakes the
  // whole set at once.
  #parkedFailedReplications = new Map<
    string,
    Map<string, ParkedReplication>
  >();

  /** Record a durable closure persist's target for
   * {@link replicateClosures}' fallback-origin read — under EVERY module
   * identity of the persisted set, not just the persist call's entry: the
   * write functions persist one addressable doc per module, and the
   * replicated entry is routinely a MODULE of a larger compiled closure
   * (a pattern served from the in-memory index carries its own module's
   * identity while the space was supplied by its importer's persist).
   *
   * Also the WAKE half of the ruled 3b close: a recorded supply re-issues
   * every parked failed replication WANTING the recorded identity. Skip
   * parks whose `toSpace` is the recorded space — a record for the child
   * itself cannot feed the read (the fallback loop skips `toSpace`), and
   * the re-issue's own success records into its `toSpace`, so this filter
   * is also what keeps a heal from waking itself. A record into a park's
   * `fromSpace` DOES wake it: the re-issue's PRIMARY read consults that
   * space, and the observed lunch geometry records exactly there (the
   * sidecar supplier persists into the PARENT space — the child
   * replication's origin). The re-issue is fire-and-forget via
   * `queueMicrotask`: this method runs inside the persistence promise the
   * E4 path AWAITS, so the hook must add neither latency nor a throw to
   * that chain. */
  #recordPersistedClosureSpaces(
    identities: Iterable<string>,
    space: MemorySpace,
  ): void {
    for (const identity of identities) {
      let spaces = this.#persistedClosureSpaces.get(identity);
      if (spaces === undefined) {
        spaces = new Set();
        this.#persistedClosureSpaces.set(identity, spaces);
      }
      spaces.add(space);
      const parked = this.#parkedFailedReplications.get(identity);
      if (parked === undefined) continue;
      for (const [key, record] of [...parked]) {
        if (record.toSpace === space) continue;
        parked.delete(key);
        queueMicrotask(() => {
          try {
            logger.warn("closure-replication-reissued", () => [
              `entry=${record.entryIdentity}`,
              `wanted=${identity}`,
              `from=${record.fromSpace}`,
              `to=${record.toSpace}`,
              `trigger=persist-record:${space}`,
            ]);
            this.#issueReplication(
              record.entryIdentity,
              record.fromSpace,
              record.toSpace,
              record.delegated,
              { wantedIdentity: identity },
            );
          } catch (error) {
            // Defensive: nothing in the re-issue path throws synchronously
            // today, but a future edit must surface loudly here rather
            // than as an unhandled microtask error.
            logger.error("closure-replication-reissue-error", () => [
              `entry=${record.entryIdentity}`,
              `wanted=${identity}`,
              String(error),
            ]);
          }
        });
      }
      if (parked.size === 0) this.#parkedFailedReplications.delete(identity);
    }
  }

  /** Failure-registration half of the ruled 3b close: park `record` under
   * `wantedIdentity` so a future matching supply record re-issues it (see
   * `#parkedFailedReplications` and the wake in
   * `#recordPersistedClosureSpaces()`).
   *
   * With `checkRecordedSupply` (first-time failures only — never the
   * re-park of a failed re-issue), consult `#persistedClosureSpaces` ONCE
   * for the wanted identity and re-issue IMMEDIATELY when a usable record
   * already exists: the record EVENT has already passed and may never
   * recur (review-6502 F1-ii — a supplier that completed entirely inside
   * the failing attempt's read window records before the failure
   * registers, and parking then would wait for an event that already
   * happened). Usable means any recorded space except `toSpace` (the
   * fallback read skips the target; a record into the attempt's own
   * `fromSpace` IS usable — the re-issue's primary read consults it). The
   * check is skipped for failed re-issues because their read just
   * consulted this very map — an immediate retry could only spin on state
   * it already read; the next matching record wakes them instead. So
   * immediate re-issues are bounded by original failures, wake re-issues
   * by matching persist events — no timers, no polling, no self-clocking
   * loop anywhere. */
  #registerFailedReplication(
    wantedIdentity: string,
    record: ParkedReplication,
    checkRecordedSupply: boolean,
  ): void {
    if (checkRecordedSupply) {
      let usable = false;
      for (
        const space of this.#persistedClosureSpaces.get(wantedIdentity) ?? []
      ) {
        if (space !== record.toSpace) {
          usable = true;
          break;
        }
      }
      if (usable) {
        logger.warn("closure-replication-reissued", () => [
          `entry=${record.entryIdentity}`,
          `wanted=${wantedIdentity}`,
          `from=${record.fromSpace}`,
          `to=${record.toSpace}`,
          "trigger=recorded-at-registration",
        ]);
        this.#issueReplication(
          record.entryIdentity,
          record.fromSpace,
          record.toSpace,
          record.delegated,
          { wantedIdentity },
        );
        return;
      }
    }
    let parked = this.#parkedFailedReplications.get(wantedIdentity);
    if (parked === undefined) {
      parked = new Map();
      this.#parkedFailedReplications.set(wantedIdentity, parked);
      while (
        this.#parkedFailedReplications.size > MAX_PARKED_FAILED_REPLICATIONS
      ) {
        const oldest = this.#parkedFailedReplications.keys().next().value;
        if (oldest === undefined) break;
        this.#parkedFailedReplications.delete(oldest);
        logger.warn("closure-replication-park-evicted", () => [
          `wanted=${oldest}`,
          `cap=${MAX_PARKED_FAILED_REPLICATIONS}`,
        ]);
      }
    }
    parked.set(
      `${record.entryIdentity}\0${record.fromSpace}\0${record.toSpace}`,
      record,
    );
    logger.warn("closure-replication-parked", () => [
      `entry=${record.entryIdentity}`,
      `wanted=${wantedIdentity}`,
      `from=${record.fromSpace}`,
      `to=${record.toSpace}`,
    ]);
  }

  // Maps each storage slot written during this PatternManager session to its
  // complete module set. One slot can hold only one closure shape at a time.
  readonly #persistedCompileCacheClosures = new Map<string, string>();
  // Writes to one storage slot are serialized. Requests for the same closure
  // share the write that is already running.
  #inProgressCompileCacheWrites = new Map<
    string,
    { closureSignature: string; persistence: Promise<void> }
  >();
  // A best-effort identity recovery that failed to persist skips the in-memory
  // artifact shortcuts on the next load so storage recovery runs again.
  #failedCompileCacheRecoveries = new Set<string>();

  constructor(readonly runtime: Runtime) {}

  /**
   * The in-flight and cached compilation tables, the module-cache bound, and
   * the three closure steps that a test drives directly.
   */
  get accessForTestingOnly(): {
    readonly addressableByIdentity: Map<string, Map<string, unknown>>;
    readonly compileCacheWrites: Set<Promise<unknown>>;
    readonly inProgressByIdentityLoads: Map<
      string,
      Promise<Pattern | undefined>
    >;
    readonly inProgressCompilations: Map<string, Promise<Pattern>>;
    maxEvaluatedModuleCacheSize: number;
    compileCacheWriter: CompileCacheWriter | undefined;
    readonly modulesByIdentity: Map<string, { exports: Exports }>;
    readonly pendingCacheWriteBacks: Set<Promise<unknown>>;
    readonly persistedCompileCacheClosures: Map<string, string>;
    hasStoredCompileCacheClosure(
      space: MemorySpace,
      modules: readonly CacheableModule[],
      entryIdentity: string,
      opts: { runtimeVersion: string },
      moduleDelegations?: ModuleDelegationMap,
    ): Promise<boolean>;
    loadPreviousSourceClosure(
      space: MemorySpace,
      entryIdentity: string,
    ): Promise<Map<string, SourceDoc>>;
    persistCompileCacheTracked(
      space: MemorySpace,
      modules: CacheableModule[],
      entryIdentity: string,
      opts: { runtimeVersion: string },
      moduleDelegations?: ModuleDelegationMap,
      delegated?: WritebackDelegation,
    ): Promise<void>;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      addressableByIdentity: this.#addressableByIdentity,
      compileCacheWrites: this.#compileCacheWrites,
      inProgressByIdentityLoads: this.#inProgressByIdentityLoads,
      inProgressCompilations: this.#inProgressCompilations,
      get maxEvaluatedModuleCacheSize() {
        return outerThis.#maxEvaluatedModuleCacheSize;
      },
      set maxEvaluatedModuleCacheSize(value) {
        outerThis.#maxEvaluatedModuleCacheSize = value;
      },
      get compileCacheWriter() {
        return outerThis.#compileCacheWriter;
      },
      set compileCacheWriter(value) {
        outerThis.#compileCacheWriter = value;
      },
      modulesByIdentity: this.#modulesByIdentity,
      pendingCacheWriteBacks: this.#pendingCacheWriteBacks,
      persistedCompileCacheClosures: this.#persistedCompileCacheClosures,
      hasStoredCompileCacheClosure: (
        space,
        modules,
        entryIdentity,
        opts,
        moduleDelegations,
      ) =>
        this.#hasStoredCompileCacheClosure(
          space,
          modules,
          entryIdentity,
          opts,
          moduleDelegations,
        ),
      loadPreviousSourceClosure: (space, entryIdentity) =>
        this.#loadPreviousSourceClosure(space, entryIdentity),
      persistCompileCacheTracked: (
        space,
        modules,
        entryIdentity,
        opts,
        moduleDelegations,
        delegated,
      ) =>
        this.#persistCompileCacheTracked(
          space,
          modules,
          entryIdentity,
          opts,
          moduleDelegations,
          delegated,
        ),
    };
  }

  /**
   * Counters for the ESM content-addressed compile cache:
   * - `byIdentityHits`: warm loads served directly by entry identity (no
   *   resolve, no compile — the fast path);
   * - `hits`: warm loads that still resolved but reused cached bodies (skipped
   *   only the TS compile);
   * - `misses`: cold compiles (also written back).
   */
  getCompileCacheStats(): {
    hits: number;
    misses: number;
    byIdentityHits: number;
  } {
    return { ...this.#esmCacheStats };
  }

  /** Resolve once all in-flight compiled-cache write-backs have settled. */
  async flushCompileCacheWrites(): Promise<void> {
    await Promise.allSettled([...this.#compileCacheWrites]);
  }

  /**
   * Whether any pattern work that produces or persists PROGRAM DOCS is
   * in flight: a by-identity load (whose cold-load arm recompiles and
   * RE-PERSISTS a space's program closure) or a compile-cache
   * write-back (which IS the program-materialization commit). Consulted
   * by the client durability barrier
   * (`Scheduler.idleWithPendingCommits` — verification-coverage.md
   * OW45, seat S-B): the barrier's contract is "once it resolves,
   * tearing the page down loses no writes", and a program commit
   * issued from a post-arrival load chain is exactly a write a reload
   * would otherwise kill (the home-profile program-write loss). Three
   * registries cover the chains end to end: `#inProgressCompilations`
   * registers SYNCHRONOUSLY at `compileOrGetPattern` — which
   * `compile-and-run` launches as a FLOATING promise, so nothing else
   * holds the scheduler while TypeScript compiles — and its promise
   * resolves only after `compilePattern` has awaited persistence; the
   * single-flight load slot registers in the load's first awaits
   * (before any storage read); and the persistence slot registers at
   * `#persistCompileCacheTracked` entry. A chain running when the
   * barrier's fixpoint drains is visible through whichever registry
   * currently holds it.
   */
  hasPendingPatternWork(): boolean {
    return this.#inProgressCompilations.size > 0 ||
      this.#inProgressByIdentityLoads.size > 0 ||
      this.#compileCacheWrites.size > 0;
  }

  /**
   * Settle every currently-registered in-progress compilation,
   * by-identity load, and compile-cache write-back (failures SETTLE —
   * allSettled by contract: they are the original caller's to surface,
   * never the barrier's to hang on; the rejecting-promise pin guards
   * the allSettled→all regression). Work registered WHILE awaiting is
   * the caller's to re-check: the scheduler barrier re-evaluates from
   * scratch after each settle, the same joint-fixpoint structure
   * pending commits use, so a chain that registers its follow-on work
   * mid-await is seen by the next pass.
   */
  async pendingPatternWorkSettled(): Promise<void> {
    await Promise.allSettled([
      ...this.#inProgressCompilations.values(),
      ...this.#inProgressByIdentityLoads.values(),
      ...this.#compileCacheWrites,
    ]);
  }

  /**
   * Attach a rehydration `program` to a hand-built pattern object (one with no
   * module-scope entry ref). The only surviving job of the old
   * `registerPattern`: source-bearing tests/builtins that construct a Pattern in
   * hand can associate its source so `getPatternProgram` (and thus
   * `getPatternProgramBySync`) returns it. No-op when the pattern already carries a
   * program. Walks to the derivation root so a copy inherits the association.
   */
  associatePatternProgram(
    pattern: Pattern | Module,
    src: RuntimeProgram | string,
  ): void {
    const root = resolveOriginal(pattern as Pattern);
    if (getPatternProgram(root)) return;
    if (typeof src === "string") {
      setPatternProgram(root, {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: src }],
      });
    } else {
      setPatternProgram(root, src);
    }
  }

  /**
   * Give a hand-built pattern a content-addressed `{ identity, symbol }` pointer
   * and index it so `artifactFromIdentitySync` / `loadPatternByIdentity` resolve
   * it in-session — the manual analog of what `compilePattern` does for an ESM
   * pattern. The caller asserts trust for `pattern` (same host-trust model as
   * `Runtime.unsafeTrustPattern`); the pattern is branded so it is treated as a
   * verified-loaded pattern. SESSION-ONLY: there is no source/compiled closure
   * behind a synthetic identity, so a fresh-runtime reload of such a pointer is
   * unrecoverable. Intended for runner internals and tests that exercise the
   * by-identity resume path without a compiled bundle.
   */
  associatePatternIdentity(
    pattern: Pattern,
    ref: { identity: string; symbol: string },
  ): void {
    brandTrustedPattern(pattern);
    this.#indexArtifact(ref.identity, ref.symbol, pattern);
  }

  /**
   * The session pointer for a KEYLESS (hand-built) pattern — one with no
   * content-addressed entry ref (it never went through an ESM compile). The
   * identity is a CONTENT hash of the pattern's structure (`createRef`), so two
   * structurally-identical hand-built patterns share one identity: a lift that
   * returns the same sub-pattern shape on every run does not churn its result
   * cell's pointer (the CT-1623 structural-dedup property the old per-structure
   * patternId provided). The pattern is branded + indexed so
   * `artifactFromIdentitySync` / `loadPatternByIdentity` resolve it. SESSION-ONLY
   * (no source/compiled closure behind a hand-built structure hash).
   */
  ensureKeylessPatternIdentity(
    pattern: Pattern,
  ): { identity: string; symbol: string } {
    const root = resolveOriginal(pattern);
    const existing = getArtifactEntryRef(root);
    if (existing) return existing;
    // Mint-site tripwire (the keyless close-out's insurance): the sanctioned
    // keyless population is runtime-BUILT pattern values — the transformer
    // hoists all source-authored lift()/handler() code to cf:module
    // (CT-1644/CT-1655), so a COMPILED pattern reaching this mint means its
    // content-addressed association went missing (a registration that never
    // ran, or a ref lost to shadowing). The source path is stamped by the
    // same module-indexing loop that assigns entry refs
    // (`registerEvaluatedModules`), so "has a source path, needs a mint" is
    // that bug surfacing — count it and say so loudly.
    if (getPatternSourcePath(root) !== undefined) {
      this.keylessMintAnomalies++;
      logger.warn("keyless-mint-missing-association", () => [
        "minting a session keyless identity for a MODULE-INDEXED pattern",
        `(source ${getPatternSourcePath(root)}) — its content-addressed`,
        "association is missing; this should never happen for compiled code",
      ]);
    }
    const identity = `${KEYLESS_PATTERN_IDENTITY_PREFIX}${
      fromURI(toURI(createRef(root, "pattern")))
    }`;
    const ref = { identity, symbol: "default" };
    this.associatePatternIdentity(root, ref);
    return ref;
  }

  /**
   * Count of keyless mints that hit a module-indexed pattern (see the
   * tripwire in {@link ensureKeylessPatternIdentity}). Always expected to be
   * zero; test suites assert on it to prove the runtime keyless population is
   * runtime-built values only.
   */
  keylessMintAnomalies = 0;

  // Session-side resolution hints for KEYLESS list-builtin ops, keyed by the
  // node's immutable inputs-doc address (`<space>\0<id>`). A keyless op's
  // durable inputs carry its full embedded graph (the never-durable contract
  // forbids the `keyless:` `$patternRef` sentinel there — L3(a), RULED
  // 2026-08-27), but the embedded round-trip corrupts nested output-alias
  // defer levels (CT-1812/CT-1811), so the SAME session that instantiated the
  // node resolves the pristine artifact through this map instead. Entries are
  // session-lifetime like the artifact index; a fresh session re-instantiates
  // the node and re-registers. Content-addressed key, so two structurally
  // identical nodes share one (equally valid) entry.
  #keylessOpRefsByInputsDoc = new Map<
    string,
    { identity: string; symbol: string }
  >();

  /** Record that the node whose immutable inputs doc is `inputsDocKey`
   * carries a keyless op resolvable in-session as `ref` (already minted and
   * indexed via {@link ensureKeylessPatternIdentity}). */
  registerKeylessOpResolution(
    inputsDocKey: string,
    ref: { identity: string; symbol: string },
  ): void {
    this.#keylessOpRefsByInputsDoc.set(inputsDocKey, ref);
  }

  /** The pristine in-session artifact for a keyless op registered under
   * `inputsDocKey`, or undefined (no registration this session — the reader
   * is not the instantiating session, so the embedded graph is all there
   * is). */
  keylessOpPatternFor(inputsDocKey: string): Pattern | undefined {
    const ref = this.#keylessOpRefsByInputsDoc.get(inputsDocKey);
    if (!ref) return undefined;
    const live = this.artifactFromIdentitySync(ref.identity, ref.symbol);
    return live !== undefined && isTrustedPattern(live)
      ? live as Pattern
      : undefined;
  }

  /**
   * Whether `identity` is a session-synthetic keyless pointer (minted by
   * {@link ensureKeylessPatternIdentity}) rather than a durable
   * content-addressed artifact identity. A fresh runtime can never load a
   * keyless pointer, so such refs must never be written into durable state.
   */
  static isKeylessPatternIdentity(identity: string): boolean {
    return isKeylessPatternIdentity(identity);
  }

  /**
   * Make a cross-space child piece independently loadable from its own space
   * (CT-1687). A fresh runtime navigating to a `Factory.inSpace(...)` child
   * loads pattern artifacts from the CHILD's space — but the parent bundle's
   * compile-cache write-back targets the space the parent compiled into, so the
   * child space had nothing and the load died with "has no stored source".
   * Replicates the content-addressed source + compiled closures into `toSpace`
   * when the pattern carries an artifact entry ref (the by-identity reload path
   * — the only one a `{ identity, symbol }` piece pointer can take).
   *
   * Closure replication is fire-and-forget (tracked in `#compileCacheWrites`,
   * awaited by `flushCompileCacheWrites`): the child is loadable in-session
   * regardless, this only affects fresh runtimes. A failure is logged and
   * retried on the next child creation and on the next persist event —
   * never on the caller's commit path. (The persist-event retry is the
   * ruled 3b close: a supply-timing failure parks under the WANTED
   * identity and `#recordPersistedClosureSpaces` re-issues it when a
   * matching supply records — see `#parkedFailedReplications`. Genuine
   * absence — an identity no server-side persist ever records — keeps
   * exactly the loud one-shot behavior this contract always had.)
   */
  replicatePatternToSpace(
    pattern: Pattern | Module,
    toSpace: MemorySpace,
    fromSpace: MemorySpace,
    delegated?: WritebackDelegation,
  ): void {
    if (toSpace === fromSpace) return;

    const entryRef = this.getArtifactEntryRef(pattern);
    if (!entryRef) return;
    this.#issueReplication(entryRef.identity, fromSpace, toSpace, delegated);
  }

  /** Issue one closure replication fire-and-forget: fresh ticket and
   * registration in `#replicationsIntoSpace` BEFORE the async body starts
   * (so a replication issued later in the same synchronous stretch
   * observes this entry when it awaits its origin's suppliers) and in
   * `#compileCacheWrites` (so `flushCompileCacheWrites` and the durability
   * barrier observe it). Shared by `replicatePatternToSpace` and the 3b
   * heal's re-issues, so a re-issued replication is a FULL fresh
   * replication — same ticket discipline, same acyclicity (the ticket
   * await stays strictly-older-only; compiles and loads never await
   * replications), same idempotent diff-to-no-op persists.
   *
   * Failures log the loud one-shot line unchanged; a SUPPLY-class failure
   * (the wanted identity readable nowhere — never a store-level throw or
   * a persist failure) additionally parks for event-driven re-supply.
   * `reissueOf` marks a park-triggered re-issue: its success logs the
   * heal line, and its failure re-parks WITHOUT the registration-time
   * map check — the failed attempt's read just consulted the map, so an
   * immediate retry could only spin on state it already read; the next
   * matching record wakes it instead. */
  #issueReplication(
    entryIdentity: string,
    fromSpace: MemorySpace,
    toSpace: MemorySpace,
    delegated: WritebackDelegation | undefined,
    reissueOf?: { wantedIdentity: string },
  ): void {
    const ticket = this.#nextReplicationTicket++;
    const replication = this.replicateClosures(
      entryIdentity,
      fromSpace,
      toSpace,
      undefined,
      delegated,
      ticket,
    ).then(() => {
      if (reissueOf !== undefined) {
        logger.warn("closure-replication-healed", () => [
          `entry=${entryIdentity}`,
          `wanted=${reissueOf.wantedIdentity}`,
          `from=${fromSpace}`,
          `to=${toSpace}`,
        ]);
      }
    }).catch((error) => {
      logger.error("closure-replication-failed", () => [
        `entry=${entryIdentity}`,
        `from=${fromSpace}`,
        `to=${toSpace}`,
        String(error),
      ]);
      if (error instanceof ClosureReplicationSupplyError) {
        this.#registerFailedReplication(
          error.wantedIdentity,
          { entryIdentity, fromSpace, toSpace, delegated },
          reissueOf === undefined,
        );
      }
    });
    let intoTarget = this.#replicationsIntoSpace.get(toSpace);
    if (intoTarget === undefined) {
      intoTarget = new Set();
      this.#replicationsIntoSpace.set(toSpace, intoTarget);
    }
    const registration = { ticket, settled: replication };
    intoTarget.add(registration);
    replication.finally(() => {
      const entries = this.#replicationsIntoSpace.get(toSpace);
      if (entries === undefined) return;
      entries.delete(registration);
      if (entries.size === 0) this.#replicationsIntoSpace.delete(toSpace);
    });
    this.#compileCacheWrites.add(replication);
    replication.finally(() => this.#compileCacheWrites.delete(replication));
  }

  /**
   * Copy the closures reachable from `entryIdentity` out of `fromSpace` into
   * `toSpace`, rebuilding the emitted-module shape the write functions expect.
   * All-or-nothing: a partial compiled closure can never be served (the loaders
   * require a full, integrity-valid hit), so an incomplete origin set throws
   * instead of persisting an unservable copy. Delegation metadata is deliberately
   * not copied across spaces: it carries writer authority and is valid only in
   * the space whose cache documents attest it. The ordinary save path still
   * preserves any authenticated delegation already present in `toSpace`.
   *
   * TypeScript-private rather than a `#` name, because `test/cell-cache.test.ts`
   * and `test/pattern-replication-sibling-race.test.ts` replace this member by
   * assignment, which a `#` method does not allow.
   */
  private async replicateClosures(
    entryIdentity: string,
    fromSpace: MemorySpace,
    toSpace: MemorySpace,
    visited = new Set<string>(),
    // Required (not optional): the older-sibling filter below is only
    // meaningful relative to THIS replication's registration order. Both
    // call sites — `replicatePatternToSpace` and the dependency recursion —
    // thread the entry replication's ticket; a caller without one has no
    // business in this private method.
    delegated: WritebackDelegation | undefined,
    ticket: number,
  ): Promise<void> {
    const visitKey = `${fromSpace}\0${toSpace}\0${entryIdentity}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);

    // The origin-space closure may still have an in-flight cache write. Reading
    // before it commits would make this replication fail even though the source
    // is about to become available. Await write-backs first. Use their own set,
    // not flushCompileCacheWrites: this replication promise is tracked there and
    // would await itself.
    await Promise.allSettled([...this.#pendingCacheWriteBacks]);
    // Then the SIBLING suppliers (see `#replicationsIntoSpace`): the origin
    // may itself be mid-supply by an earlier-registered replication INTO
    // it. Await strictly older tickets only — acyclic by construction —
    // then read; genuine absence still throws loudly below. Event-driven
    // (the siblings' own completion), never a timer.
    const intoOrigin = this.#replicationsIntoSpace.get(fromSpace);
    if (intoOrigin !== undefined) {
      const older = [...intoOrigin]
        .filter((entry) => entry.ticket < ticket)
        .map((entry) => entry.settled);
      if (older.length > 0) await Promise.allSettled(older);
    }
    // Replicate the same cached variant the compile path uses — the coverage
    // suffix keeps an instrumented closure from being served under an ordinary
    // key (and vice versa).
    const runtimeVersion = moduleByteCacheRuntimeVersion(
      await getCompileCacheRuntimeVersion(),
      { patternCoverage: this.runtime.patternCoverage !== undefined },
    );

    /** One origin's verified closure read, complete or classified.
     * Verification recomputes module identities with the default ("")
     * runtimeFingerprint — the same default every compile path in the
     * tree uses today. If a non-empty fingerprint is ever threaded into
     * compilation, it must be threaded here too or verification will
     * reject every closure (logged as replication failures). */
    const readOrigin = async (origin: MemorySpace): Promise<
      | {
        complete: true;
        sourceDocs: NonNullable<
          Awaited<ReturnType<typeof loadVerifiedSourceClosure>>
        >;
        compiledDocs:
          | Awaited<ReturnType<typeof loadCompiledClosure>>
          | undefined;
      }
      | { complete: false; reason: string }
    > => {
      const readTx = this.runtime.edit();
      let sourceDocs;
      let compiledDocs;
      try {
        sourceDocs = await loadVerifiedSourceClosure(
          this.runtime,
          origin,
          entryIdentity,
          readTx,
        );
        if (runtimeVersion === undefined) {
          compiledDocs = undefined;
        } else {
          const cacheOpts = { runtimeVersion };
          compiledDocs = await loadCompiledClosure(
            this.runtime,
            origin,
            entryIdentity,
            cacheOpts,
            readTx,
          );
        }
      } finally {
        readTx.abort?.("closure-replication read complete");
      }
      if (!sourceDocs?.has(entryIdentity)) {
        return {
          complete: false,
          reason: "source closure unavailable in origin space",
        };
      }
      if (
        runtimeVersion !== undefined &&
        isPatternCoverageCacheRuntimeVersion(runtimeVersion) &&
        (compiledDocs === undefined ||
          !cacheEntriesIncludePatternCoverage(compiledDocs.values()))
      ) {
        return {
          complete: false,
          reason: "coverage spans unavailable in origin space",
        };
      }
      if (runtimeVersion !== undefined) {
        for (const identity of sourceDocs.keys()) {
          if (!compiledDocs?.has(identity)) {
            return {
              complete: false,
              reason: `compiled doc missing for ${identity}`,
            };
          }
        }
      }
      return { complete: true, sourceDocs, compiledDocs };
    };

    /** One full read attempt: the caller-named origin, then the FALLBACK
     * ORIGINS (see `#persistedClosureSpaces`): the caller-named origin is a
     * provenance heuristic and can be closure-less through no fault of any
     * writer — `loadPatternByIdentity` serves patterns from the in-memory
     * artifact index with no per-space persist. The closure is
     * CONTENT-ADDRESSED: any space this manager durably persisted this
     * entry into holds byte-identical docs (the verified read recomputes
     * identities and the CFC integrity gate stays fail-closed), so retry
     * the read against the recorded persist targets before failing. Loud
     * on use: the lane log shows when the heuristic origin was dry. An
     * incomplete result carries the PRIMARY origin's reason — the
     * production error string the arc's forensics grep for. */
    const readOriginWithFallbacks = async (): Promise<
      Awaited<ReturnType<typeof readOrigin>>
    > => {
      const primary = await readOrigin(fromSpace);
      if (primary.complete) return primary;
      for (
        const fallback of this.#persistedClosureSpaces.get(entryIdentity) ?? []
      ) {
        if (fallback === fromSpace || fallback === toSpace) continue;
        let read: Awaited<ReturnType<typeof readOrigin>>;
        try {
          read = await readOrigin(fallback);
        } catch (error) {
          // A store-level error on ONE candidate must not abort the loop —
          // the remaining recorded targets hold byte-identical copies and
          // deserve their try. Loud, so the store failure is never
          // silently absorbed into a clean miss.
          logger.warn("closure-replication-fallback-read-failed", () => [
            `entry=${entryIdentity}`,
            `fallback=${fallback}`,
            String(error),
          ]);
          continue;
        }
        if (read.complete) {
          logger.warn("closure-replication-fallback-origin", () => [
            `entry=${entryIdentity}`,
            `from=${fromSpace}`,
            `to=${toSpace}`,
            `fallback=${fallback}`,
            `originReason=${primary.reason}`,
          ]);
          return read;
        }
      }
      return primary;
    };

    let origin = await readOriginWithFallbacks();
    if (!origin.complete) {
      // GEOMETRY 3 (verification-coverage.md OW45; direct-CI probe 4, run
      // 33165960083): the SUPPLIER COMPILE itself can still be mid-flight
      // at consult time — no persist has completed anywhere yet, so the
      // heuristic origin AND the fallback map are both correctly dry, and
      // a one-shot throw here parks the target space's demanded roots
      // `pattern-unloadable` forever. Await the in-flight compile
      // registries ONCE — a SNAPSHOT, allSettled (a failing compile must
      // neither hang nor reject this replication; entries registered
      // after the snapshot are the next consult's business), covering
      // BOTH cold compiles AND by-identity loads (a supplier can be a
      // load's recovery compile) but NEVER `#compileCacheWrites`: this
      // replication promise lives there and would await itself. Acyclic:
      // compiles and loads never await replications (their only
      // replication call is fire-and-forget), and a compile promise
      // resolves only after its E4 persist recorded into
      // `#persistedClosureSpaces`.
      //
      // EMPTY SNAPSHOT → NO RETRY, byte-identical one-shot throw below.
      // Deliberate, twice over: (a) with nothing in the registries there
      // is no supplier whose completion the await could observe — every
      // `#pendingCacheWriteBacks` member belongs to a compile or load
      // (registry-covered here) or to a sibling replication, which the
      // strictly-older-ticket await above already covers at registration
      // time, so an empty-registry retry adds no coverage the design
      // claims; (b) an empty-registry re-read WOULD still re-race the
      // sibling window nondeterministically, quietly double-covering the
      // ticket await — the exact masking that made the F1 pin soft. The
      // absence of a `closure-replication-await-inflight` line before a
      // `closure-replication-failed` line is therefore the pre-declared
      // geometry-3b signature. Precisely (review-6502 F1): zero-announce
      // proves "no supplier REGISTERED at snapshot time" — a strict
      // superset of "not started" that also admits a supplier completed
      // inside the read window or a load resolved with its repair
      // persist floating. All of it — 3b proper and both slivers — now
      // ends in the same place: the throw below parks the failure for
      // event-driven re-supply (the ruled 3b close; see
      // `#parkedFailedReplications` and the register's RULING block), so
      // the short-circuit stays exactly as cheap and mask-free as
      // designed while no rescueable interleaving is lost.
      const inFlightCompilations = [...this.#inProgressCompilations.values()];
      const inFlightLoads = [...this.#inProgressByIdentityLoads.values()];
      if (inFlightCompilations.length > 0 || inFlightLoads.length > 0) {
        logger.warn("closure-replication-await-inflight", () => [
          `entry=${entryIdentity}`,
          `from=${fromSpace}`,
          `to=${toSpace}`,
          `compilations=${inFlightCompilations.length}`,
          `byIdentityLoads=${inFlightLoads.length}`,
        ]);
        await Promise.allSettled([...inFlightCompilations, ...inFlightLoads]);
        // A settled by-identity load's recovery persist is fire-and-forget:
        // the load resolves after REGISTERING it in
        // `#pendingCacheWriteBacks`, not after completing it. Observe a
        // FRESH snapshot of that set (replications are never in it — no
        // self-await) so the persist has recorded before the re-read
        // consults the map.
        await Promise.allSettled([...this.#pendingCacheWriteBacks]);
        origin = await readOriginWithFallbacks();
      }
    }
    if (!origin.complete) {
      // The one-shot contract stands byte-identical on the still-failing
      // path: same loud throw, same production reason string (the error
      // class keeps name "Error", so `String(error)` in the failure line
      // is unchanged). The class carries the WANTED identity — THIS
      // frame's `entryIdentity`, which for the dependency recursion is
      // the dependency's own identity — so the catch in
      // `#issueReplication` can park the failure for event-driven
      // re-supply under the identity a future persist record will name
      // (the ruled 3b close).
      throw new ClosureReplicationSupplyError(origin.reason, entryIdentity);
    }
    const { sourceDocs, compiledDocs } = origin;
    const modules: CacheableModule[] = [];
    const fabricDependencies = new Set<string>();
    for (const [identity, doc] of sourceDocs) {
      const compiled = compiledDocs?.get(identity);
      if (runtimeVersion !== undefined && !compiled) {
        throw new Error(`compiled doc missing for ${identity}`);
      }
      const fabricImports = fabricImportRefsFromSource(doc);
      for (const imp of fabricImports) {
        fabricDependencies.add(imp.targetIdentity);
      }
      modules.push({
        identity,
        filename: doc.filename,
        source: doc.code,
        js: compiled?.code ?? "",
        ...(compiled?.sourceMap !== undefined
          ? { sourceMap: compiled.sourceMap }
          : {}),
        ...(compiled?.patternCoverageSpans !== undefined
          ? { patternCoverageSpans: [...compiled.patternCoverageSpans] }
          : {}),
        ...(compiled?.builderSourceSites !== undefined
          ? { builderSourceSites: compiled.builderSourceSites }
          : {}),
        ...(compiled?.policyManifests !== undefined
          ? { policyManifests: compiled.policyManifests }
          : {}),
        // The write functions re-derive cache-retention links. Authored and
        // source-package identity edges remain attached to the module.
        imports: uniqueCacheableImports([
          ...doc.imports
            .filter((imp) => !imp.specifier.startsWith(ROOT_LINK_SPECIFIER))
            .map((imp) => ({
              specifier: imp.specifier,
              targetIdentity: imp.identity,
            })),
          ...fabricImports,
        ]),
      });
    }
    if (runtimeVersion === undefined) {
      await this.#persistSourceCacheTracked(
        toSpace,
        modules,
        entryIdentity,
        undefined,
        delegated,
      );
    } else {
      await this.#persistCompileCacheTracked(
        toSpace,
        modules,
        entryIdentity,
        { runtimeVersion },
        undefined,
        delegated,
      );
    }

    for (const dependencyIdentity of fabricDependencies) {
      await this.replicateClosures(
        dependencyIdentity,
        fromSpace,
        toSpace,
        visited,
        delegated,
        ticket,
      );
    }
  }

  async #loadPreviousSourceClosure(
    space: MemorySpace,
    entryIdentity: string,
  ): Promise<Map<string, SourceDoc>> {
    const tx = this.runtime.edit();
    try {
      const closure = await loadVerifiedSourceClosure(
        this.runtime,
        space,
        entryIdentity,
        tx,
      );
      if (!closure?.has(entryIdentity)) {
        throw new Error(
          `cannot authorize module update from ${entryIdentity}: ` +
            "verified source closure is unavailable",
        );
      }
      return closure;
    } finally {
      tx.abort?.("setsrc predecessor source load complete");
    }
  }

  async compilePattern(
    input: string | RuntimeProgram,
    cacheCtx?: {
      space: MemorySpace;
      tx?: IExtendedStorageTransaction;
      // When the entry module's content identity is already known (e.g. stored
      // in pattern metadata from a prior compile), the ESM cache path loads the
      // compiled closure by identity and skips resolve + compile entirely.
      knownEntryIdentity?: string;
      // Invoked once the entry module's content identity is known for this
      // compile (warm-by-identity or cold). Lets the caller persist it (e.g.
      // into pattern metadata) so subsequent loads can take the fast path.
      onEntryIdentity?: (entryIdentity: string) => void;
      // `piece setsrc` predecessor. Its verified recursive source closure is
      // matched to the emitted module set by canonical filename, producing the
      // per-module update-authority delegations persisted with the successor.
      previousEntryIdentity?: string;
    },
  ): Promise<Pattern> {
    let program: RuntimeProgram;
    if (typeof input === "string") {
      program = {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: input }],
      };
    } else {
      program = input;
    }

    // Use the content-addressed cell cache when we have a target space and
    // CFC is enforced (the compiled-set integrity label only persists — and
    // is only trusted on read — under an enforcing mode; see cell-cache).
    if (cacheCtx && this.runtime.cfcEnforcementMode !== "disabled") {
      return await this.#compileViaCellCache(program, cacheCtx);
    }
    const patternCoverage = this.#patternCoverageFor();
    const { id, graph, mainSpecifier, entryIdentity } = await this.runtime
      .harness.compileToRecordGraph(
        program,
        {
          ...(cacheCtx ? { fabricImports: { space: cacheCtx.space } } : {}),
          ...(patternCoverage ? { patternCoverage } : {}),
        },
      );
    cacheCtx?.onEntryIdentity?.(entryIdentity);
    // evaluateRecordGraph is a single synchronous SES stretch; in the browser
    // worker, yield first so event-loop work queued behind the compile runs
    // before it, not after. No-op in Deno, where it would be batch overhead.
    await interleaveCompileYield();
    const result = this.runtime.harness.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program,
    );
    return this.#patternFromEvaluation(result, program);
  }

  /**
   * The pattern-coverage collector to instrument a compile with: a per-call
   * option wins, else the runtime-level default (`RuntimeOptions.patternCoverage`).
   * Undefined leaves the compile uninstrumented.
   */
  #patternCoverageFor(
    options?: TypeScriptHarnessProcessOptions,
  ): PatternCoverageCollector | undefined {
    return options?.patternCoverage ?? this.runtime.patternCoverage;
  }

  /**
   * Compile + evaluate a program's modules AND register the evaluated artifacts,
   * returning the full module namespace (`EvaluateResult`).
   *
   * This is the load seam for callers that need the raw evaluated namespace —
   * `main.default`, a named `fetchMocks` export, multi-user descriptors — rather
   * than the single `Pattern` that `compilePattern` returns. It is the reason the
   * CLI pattern-test harness and the multi-user worker previously reached for the
   * lower-level `Engine.compileAndEvaluateModules` directly and skipped
   * registration (CT-1811): map/filter/flatMap ops then had no content-addressed
   * entry ref and fell back to a defer-corrupted embedded graph instead of their
   * canonical `$patternRef` artifact.
   *
   * Registration is fused with evaluation here on purpose, so it cannot be
   * forgotten — mirroring what the runtime's own `compilePattern` /
   * `#patternFromEvaluation` load path does. Reach for the bare
   * `Engine.compileAndEvaluateModules` only to inspect serialized/verified output
   * *without running* (engine unit tests), where stamping entry refs is unwanted.
   */
  async compileAndRegisterModules(
    program: RuntimeProgram,
    options?: TypeScriptHarnessProcessOptions,
  ): Promise<EvaluateResult> {
    const patternCoverage = this.#patternCoverageFor(options);
    const effectiveOptions: TypeScriptHarnessProcessOptions = {
      ...options,
      patternCoverage,
    };
    const byteCache = this.runtime.moduleByteCache;
    const runtimeVersion = byteCache === undefined
      ? undefined
      : moduleByteCacheRuntimeVersion(
        await getCompileCacheRuntimeVersion(),
        { patternCoverage: patternCoverage !== undefined },
      );
    if (byteCache === undefined || runtimeVersion === undefined) {
      const result = await this.runtime.harness.compileAndEvaluateModules(
        program,
        effectiveOptions,
      );
      this.registerEvaluatedModules(result);
      return result;
    }

    const { id, graph, mainSpecifier, modules } = await this.runtime.harness
      .compileToRecordGraph(program, {
        ...effectiveOptions,
        precompiledModulesFor: ({ identities }) =>
          Promise.resolve(byteCache.getCompleteSet(runtimeVersion, identities)),
      });
    byteCache.putAll(runtimeVersion, modules);
    // Yield ahead of the synchronous SES evaluation (see compilePattern).
    await interleaveCompileYield();
    const result = this.runtime.harness.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program,
    );
    this.registerEvaluatedModules(result);
    return result;
  }

  /**
   * ESM compile + evaluate backed by the content-addressed cell cache in
   * `cacheCtx.space`. On a warm full hit the per-module compiled bodies are
   * reused (no TypeScript compile / transformer pipeline / SES re-verify); on a
   * miss the program is compiled and its modules are written back (source +
   * integrity-stamped compiled docs) on a fresh transaction before returning.
   */
  async #compileViaCellCache(
    program: RuntimeProgram,
    cacheCtx: {
      space: MemorySpace;
      tx?: IExtendedStorageTransaction;
      knownEntryIdentity?: string;
      onEntryIdentity?: (entryIdentity: string) => void;
      previousEntryIdentity?: string;
    },
  ): Promise<Pattern> {
    const harness = this.runtime.harness;
    const { space } = cacheCtx;
    const previousSourceDocs = cacheCtx.previousEntryIdentity === undefined
      ? undefined
      : await this.#loadPreviousSourceClosure(
        space,
        cacheCtx.previousEntryIdentity,
      );
    const patternCoverage = this.#patternCoverageFor();
    // The instrumented compile is a distinct cached variant: the coverage suffix
    // keeps its compiled bytes from colliding with an ordinary compile of the
    // same source under one key, and makes a coverage-on runtime miss (and
    // recompile-with-coverage) rather than reuse uninstrumented bytes. Source
    // docs are keyed by content identity, not by this version, so they stay
    // shared — a coverage run reuses the persisted source and only recompiles.
    const runtimeVersion = moduleByteCacheRuntimeVersion(
      await getCompileCacheRuntimeVersion(),
      { patternCoverage: patternCoverage !== undefined },
    );
    if (runtimeVersion === undefined) {
      const { id, graph, mainSpecifier, entryIdentity, modules } = await harness
        .compileToRecordGraph(
          program,
          {
            fabricImports: { space },
            ...(patternCoverage ? { patternCoverage } : {}),
          },
        );
      const moduleDelegations = previousSourceDocs === undefined
        ? new Map<string, ReadonlySet<string>>()
        : deriveModuleDelegations(previousSourceDocs, modules);
      await this.#persistSourceCacheTracked(
        space,
        modules,
        entryIdentity,
        moduleDelegations,
      );
      cacheCtx.onEntryIdentity?.(entryIdentity);
      // Yield ahead of the synchronous SES evaluation (see compilePattern).
      await interleaveCompileYield();
      const result = harness.evaluateRecordGraph(
        id,
        graph,
        mainSpecifier,
        program,
      );
      return this.#patternFromEvaluation(result, program, entryIdentity);
    }
    const cacheOpts = { runtimeVersion };

    // Fast path — warm load BY IDENTITY: if the entry's content identity is
    // already known (stored from a prior compile), load the compiled closure
    // directly and build+evaluate from it, skipping `resolve` and `compile`
    // entirely. Falls through to the compile path on any miss/incompleteness
    // (evaluateCachedModules re-verifies the graph, so an incomplete closure
    // throws and we recompile).
    if (cacheCtx.knownEntryIdentity && previousSourceDocs === undefined) {
      const byIdentity = await this.#tryWarmLoadByIdentity(
        cacheCtx.knownEntryIdentity,
        space,
        cacheOpts,
        program,
      );
      if (byIdentity) {
        this.#esmCacheStats.byIdentityHits++;
        cacheCtx.onEntryIdentity?.(cacheCtx.knownEntryIdentity);
        return byIdentity;
      }
    }

    // Read the cache on a dedicated, owned transaction (used read-only — the
    // load path only reads, and it is aborted below, never committed) so
    // cache-cell reads never enter the caller's transaction (whose commit must
    // not gain dependencies on the write-back), and so repeated compiles don't
    // accumulate open transactions.
    const readTx = this.runtime.edit();

    const byteCache = this.runtime.moduleByteCache;
    // The per-space storage closure served the full module set (already durable
    // in this space, so no write-back needed).
    let warmHit = false;
    // Cached compiled bodies served the full module set. They can come from the
    // process byte cache or from compiled storage whose source closure needs
    // repair. Either skips the transform-and-emit step but still triggers a
    // write-back.
    let compiledBodiesServed = false;
    let compiled;
    try {
      compiled = await harness.compileToRecordGraph(program, {
        fabricImports: { space },
        // A miss below falls through to a fresh compile; instrument it when
        // coverage is on so the recompiled bytes carry the hit calls. A warm hit
        // reuses bytes a prior coverage compile already instrumented (the coverage
        // suffix on `runtimeVersion` keeps the two variants apart).
        ...(patternCoverage ? { patternCoverage } : {}),
        // The bodies returned below come either from the process byte cache or
        // from `loadCompiledClosure`, an integrity-gated (`requiredIntegrity`,
        // fail-closed) read of the compiled set. On a full hit the byte cache's
        // provenance (see the channel below) / the CFC integrity label is the
        // security boundary, so skip the redundant per-module SES re-verification
        // (threat model: docs/specs/module-loading.md). A partial/miss returns
        // undefined below → fresh compile → bodies are SES-verified as usual.
        trustedBodies: true,
        precompiledModulesFor: async ({ entryIdentity, identities }) => {
          // Concurrency-safe timing: explicit start (no shared timer key, which
          // parallel compiles would clobber). Same for the others below.
          const readStart = performance.now();
          const closure = await loadCompiledClosure(
            this.runtime,
            space,
            entryIdentity,
            cacheOpts,
            readTx,
          );
          logger.time(readStart, "compile-cache", "read");
          // Full hit only: every emitted module must be present (and
          // integrity-valid). A partial set cannot be trusted (transitively
          // sensitive identities), so fall back to a full recompile.
          const storageIsComplete = identities.every((identity) =>
            closure.has(identity)
          );
          let storageBodiesNeedingRepair:
            | Map<string, CompiledModuleArtifact>
            | undefined;
          if (storageIsComplete) {
            const bodies = new Map<string, CompiledModuleArtifact>();
            for (const [identity, doc] of closure) {
              bodies.set(identity, {
                js: doc.code,
                ...(doc.sourceMap === undefined
                  ? {}
                  : { sourceMap: doc.sourceMap }),
                ...(doc.patternCoverageSpans === undefined
                  ? {}
                  : { patternCoverageSpans: [...doc.patternCoverageSpans] }),
                ...(doc.builderSourceSites === undefined
                  ? {}
                  : { builderSourceSites: doc.builderSourceSites }),
                ...(doc.policyManifests === undefined
                  ? {}
                  : { policyManifests: doc.policyManifests }),
              });
            }
            if (
              !patternCoverage ||
              cacheEntriesIncludePatternCoverage(bodies.values())
            ) {
              const sourceClosure = await loadVerifiedSourceClosure(
                this.runtime,
                space,
                entryIdentity,
                readTx,
              );
              if (sourceClosure?.has(entryIdentity)) {
                warmHit = true;
                return bodies;
              }
              storageBodiesNeedingRepair = bodies;
            }
          }

          // A storage miss makes any remembered success for this slot stale.
          // The process cache can still skip compilation, but the resulting
          // closure must be written back into the space again.
          this.#persistedCompileCacheClosures.delete(
            compileCachePersistenceSlotKey(space, entryIdentity, cacheOpts),
          );
          if (storageBodiesNeedingRepair !== undefined) {
            compiledBodiesServed = true;
            return storageBodiesNeedingRepair;
          }
          // Process byte cache (cross-runtime, cross-space): a full hit skips
          // the transform-and-emit step (`compileToModules`: TS program build,
          // type-check, CF transform, emit). Trust by provenance: bytes this
          // process compiled were SES-verified then; bytes a test seeded from a
          // CI disk file are trusted via the workflow cache key, which
          // fingerprints every compile input. Nothing in production installs a
          // byte cache.
          const processBodies = byteCache?.getCompleteSet(
            cacheOpts.runtimeVersion,
            identities,
          );
          if (
            processBodies &&
            (!patternCoverage ||
              cacheEntriesIncludePatternCoverage(processBodies.values()))
          ) {
            compiledBodiesServed = true;
            return processBodies;
          }
          return undefined;
        },
      });
    } finally {
      // Release the read-only cache transaction (no commit needed) so repeated
      // compiles don't accumulate open transactions.
      readTx.abort?.("compile-cache read complete");
    }
    const { id, graph, mainSpecifier, entryIdentity, modules } = compiled;
    const moduleDelegations = previousSourceDocs === undefined
      ? new Map<string, ReadonlySet<string>>()
      : deriveModuleDelegations(previousSourceDocs, modules);
    cacheCtx.onEntryIdentity?.(entryIdentity);

    // Populate the process byte cache with this program's module bytes (freshly
    // compiled, or reused from storage). Idempotent and content-addressed, so a
    // redundant put is harmless. A later runtime or space then reuses these
    // modules instead of re-transforming them.
    byteCache?.putAll(cacheOpts.runtimeVersion, modules);

    // Yield ahead of the synchronous SES evaluation (see compilePattern).
    await interleaveCompileYield();
    const evalStart = performance.now();
    const result = harness.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program,
    );
    logger.time(evalStart, "compile-cache", "evaluate");

    if (warmHit) {
      // The per-space storage closure was just READ from this space, i.e. it is
      // already durable here — no write-back.
      this.#esmCacheStats.hits++;
    } else {
      this.#esmCacheStats[compiledBodiesServed ? "hits" : "misses"]++;
    }
    if (!warmHit || moduleDelegations.size > 0) {
      // Persist the module set into this space. AWAITED (identity E4): refs-only
      // pattern JSON makes artifact persistence part of the compilation
      // contract — a cell can only carry a `$patternRef` after compilePattern
      // returned, so completing the write here guarantees every persisted ref
      // has a durable closure behind it (no race against session end). This
      // covers BOTH a cold compile AND a process-byte-cache hit: in the latter
      // the transform-and-emit step was skipped, but this space's persisted
      // cache may be empty (e.g. a fresh space), and the by-identity reload path
      // needs the closure here. A failed write fails the compile: persisted
      // refs-only pattern JSON would otherwise point at a closure that is not
      // durable in `space`.
      await this.#persistCompileCacheTracked(
        space,
        modules,
        entryIdentity,
        cacheOpts,
        moduleDelegations,
      );
    }

    return this.#patternFromEvaluation(result, program, entryIdentity);
  }

  /**
   * Resolve-free warm load: fetch the integrity-valid compiled closure for
   * `entryIdentity` and build + evaluate the pattern directly from those cached
   * bodies (no `resolve`, no `compile`). Returns the pattern, or `undefined`
   * if the closure is absent/incomplete/invalid (caller then recompiles).
   */
  async #tryWarmLoadByIdentity(
    entryIdentity: string,
    space: MemorySpace,
    cacheOpts: { runtimeVersion: string },
    program: RuntimeProgram,
  ): Promise<Pattern | undefined> {
    const harness = this.runtime.harness;
    // `cacheOpts.runtimeVersion` already selects the coverage variant, so the
    // bodies read below carry probes exactly when this is set.
    const patternCoverage = this.#patternCoverageFor();
    const readTx = this.runtime.edit();
    let closure;
    let sourceClosure;
    try {
      const readStart = performance.now();
      closure = await loadCompiledClosure(
        this.runtime,
        space,
        entryIdentity,
        cacheOpts,
        readTx,
      );
      if (closure.has(entryIdentity)) {
        sourceClosure = await loadVerifiedSourceClosure(
          this.runtime,
          space,
          entryIdentity,
          readTx,
        );
      }
      logger.time(readStart, "compile-cache", "read-by-identity");
    } finally {
      readTx.abort?.("compile-cache by-identity read complete");
    }
    if (
      !closure.has(entryIdentity) || !sourceClosure?.has(entryIdentity) ||
      (patternCoverage !== undefined &&
        !cacheEntriesIncludePatternCoverage(closure.values()))
    ) {
      this.#persistedCompileCacheClosures.delete(
        compileCachePersistenceSlotKey(space, entryIdentity, cacheOpts),
      );
      return undefined;
    }

    const cachedModules: CachedCompiledModule[] = [...closure].map(
      ([identity, doc]) => ({
        identity,
        filename: doc.filename,
        code: doc.code,
        // A data entry rides the closure to reach the compartment; the record
        // builder takes it out before anything reads `code` as a body.
        ...(doc.kind === "data" ? { isData: true } : {}),
        ...(doc.sourceMap !== undefined
          ? { sourceMap: doc.sourceMap as never }
          : {}),
        // Fix B: carry the precomputed record surface so the boot record build
        // skips the in-worker parse (absent on legacy docs → parse fallback).
        ...(doc.exportNames !== undefined
          ? { exportNames: doc.exportNames }
          : {}),
        ...(doc.starTargetSpecs !== undefined
          ? { starTargetSpecs: doc.starTargetSpecs }
          : {}),
        ...(doc.importSpecs !== undefined
          ? { importSpecs: doc.importSpecs }
          : {}),
        // The spans naming the lines this body's coverage probes stand for.
        ...(doc.patternCoverageSpans !== undefined
          ? { patternCoverageSpans: doc.patternCoverageSpans }
          : {}),
        ...(doc.builderSourceSites !== undefined
          ? { builderSourceSites: doc.builderSourceSites }
          : {}),
        // Identity and cache-retention edges do not resolve module records.
        imports: doc.imports
          .filter((i) =>
            !i.specifier.startsWith(ROOT_LINK_SPECIFIER) &&
            !i.specifier.startsWith(SOURCE_ROOT_SPECIFIER) &&
            !i.specifier.startsWith(DATA_FILE_SPECIFIER)
          )
          .map((i) => ({ specifier: i.specifier, targetIdentity: i.identity })),
      }),
    );

    try {
      const result = await harness.evaluateCachedModules(
        cachedModules,
        entryIdentity,
        // Bodies came from the integrity-gated compiled-set read
        // (`loadCompiledClosure`, `requiredIntegrity`), so the CFC label is the
        // security boundary — skip redundant SES body re-verification.
        {
          sourceFiles: program.files,
          ...(program.dataFiles === undefined
            ? {}
            : { dataFiles: program.dataFiles }),
          trustedBodies: true,
          ...(patternCoverage ? { patternCoverage } : {}),
        },
      );
      return this.#patternFromEvaluation(result, program, entryIdentity);
    } catch (error) {
      // Incomplete/invalid cached closure — fall back to recompile.
      logger.warn("compile-cache-by-identity-miss", () => [
        `entry=${entryIdentity}`,
        String(error),
      ]);
      return undefined;
    }
  }

  /**
   * Load a pattern referenced purely by content identity — the
   * `{identity, symbol}` result-cell reference — the ONLY pattern pointer. The
   * resolution chain is: in-memory live module → integrity-valid compiled
   * closure → cold recompile from the verified `pattern:<identity>` source-doc
   * closure (`#tryColdLoadByIdentity()`, which survives a
   * runtime-version change). No TypeScript program in hand, no meta cell — the
   * source docs are the single durable source.
   *
   * Returns the pattern, or `undefined` when the by-identity load is
   * unavailable (CFC not enforcing / closure absent or incomplete / invalid /
   * no stored source). A piece carrying only a legacy `pattern` link (no
   * `patternIdentity`) is unrecoverable — the sanctioned data-wipe outcome.
   */
  async loadPatternByIdentity(
    entryIdentity: string,
    symbol: string,
    space: MemorySpace,
  ): Promise<Pattern | undefined> {
    const recoveryKey = compileCacheRecoveryKey(space, entryIdentity);
    const retryFailedRecovery = this.#failedCompileCacheRecoveries.has(
      recoveryKey,
    );
    // In-memory artifact index: the pattern may already be live this session —
    // an evaluated ESM artifact, or a hand-built pattern given a synthetic
    // pointer via `associatePatternIdentity`. This path is independent of the
    // compiled cache (and of CFC enforcement), so it serves the same artifact
    // `artifactFromIdentitySync` would return.
    const indexed = this.#addressableByIdentity.get(entryIdentity)?.get(symbol);
    if (
      !retryFailedRecovery && indexed !== undefined && isTrustedPattern(indexed)
    ) {
      this.#esmCacheStats.byIdentityHits++;
      return indexed;
    }
    // A keyless identity is session-only by construction: no source or
    // compiled closure exists behind it anywhere, so once the in-memory index
    // missed, storage cannot help. Answer definitively without probing (a
    // pointer like this read from durable state is a pre-guard legacy orphan
    // — tolerated, never loadable; see L3(a), RULED 2026-08-27).
    if (isKeylessPatternIdentity(entryIdentity)) {
      logger.debug("keyless-identity-load-skipped", () => [
        `session-synthetic identity ${entryIdentity}#${symbol} is not in the`,
        "in-memory index; no durable closure can exist for it",
      ]);
      return undefined;
    }
    if (this.runtime.cfcEnforcementMode === "disabled") {
      return undefined;
    }
    // In-memory fast path (CT-1623): the module may already be live from a
    // parent bundle's evaluation (e.g. a sub-pattern of the just-loaded
    // space root). Reuse it directly — no storage closure read, no SES re-eval.
    const live = retryFailedRecovery
      ? undefined
      : this.#patternFromEvaluatedModule(entryIdentity, symbol);
    if (live) {
      this.#esmCacheStats.byIdentityHits++;
      return live;
    }
    // Check before single-flight: follower retries re-enter from the top and
    // should observe a deterministic failure recorded by the leader. Sitting
    // ahead of the compiled-closure read is sound because the runtime version
    // fingerprints all compile-shaping code (`compiler-fingerprint.deno.ts`),
    // so no same-version peer can publish a compiled closure for bytes this
    // session cannot compile itself.
    const key = `${space}\0${entryIdentity}`;
    const runtimeVersion = moduleByteCacheRuntimeVersion(
      await getCompileCacheRuntimeVersion(),
      { patternCoverage: this.#patternCoverageFor() !== undefined },
    );
    if (this.#coldLoadNegativeMemo.suppresses(key, runtimeVersion)) {
      return undefined;
    }
    // Single-flight the expensive tail (see `#inProgressByIdentityLoads`).
    const pending = this.#inProgressByIdentityLoads.get(key);
    if (pending === undefined) {
      const load = this.#loadPatternByIdentityFromStorage(
        entryIdentity,
        symbol,
        space,
      ).finally(() => this.#inProgressByIdentityLoads.delete(key));
      this.#inProgressByIdentityLoads.set(key, load);
      return await load;
    }
    // Follower: the leader's evaluation indexes every symbol of the closure,
    // so after it settles the in-memory lookups above serve this call. Its
    // failure is the leader caller's to surface; this call retries on its own
    // behalf below.
    await pending.catch(() => {});
    // Back through the front door: hits the now-populated indexes in the
    // common case. If the leader failed or did not surface this symbol, the
    // in-flight entry is gone, so this call becomes the leader of its own
    // attempt — the same load it would have run without dedup. Each pass
    // consumes a settled leader, so the recursion is bounded by the number of
    // concurrent callers.
    return await this.loadPatternByIdentity(entryIdentity, symbol, space);
  }

  /**
   * The storage-backed tail of {@link loadPatternByIdentity}: closure read,
   * SES evaluation, artifact indexing, and the cold-load recovery fallbacks.
   * Callers must hold the single-flight slot for `(space, entryIdentity)`.
   */
  async #loadPatternByIdentityFromStorage(
    entryIdentity: string,
    symbol: string,
    space: MemorySpace,
  ): Promise<Pattern | undefined> {
    const harness = this.runtime.harness;
    const patternCoverage = this.#patternCoverageFor();
    // Select the same cached variant the compile path wrote. A coverage-on
    // runtime resumes from the instrumented closure; reading the ordinary key
    // here would serve uninstrumented bodies for an instrumented run.
    const runtimeVersion = moduleByteCacheRuntimeVersion(
      await getCompileCacheRuntimeVersion(),
      { patternCoverage: patternCoverage !== undefined },
    );
    if (runtimeVersion === undefined) {
      return await this.#tryColdLoadByIdentity(entryIdentity, symbol, space);
    }
    const cacheOpts = { runtimeVersion };

    const readTx = this.runtime.edit();
    let closure;
    try {
      const readStart = performance.now();
      closure = await loadCompiledClosure(
        this.runtime,
        space,
        entryIdentity,
        cacheOpts,
        readTx,
      );
      logger.time(readStart, "compile-cache", "load-pattern-by-identity");
    } finally {
      readTx.abort?.("load-pattern-by-identity read complete");
    }
    if (
      !closure.has(entryIdentity) ||
      (patternCoverage !== undefined &&
        !cacheEntriesIncludePatternCoverage(closure.values()))
    ) {
      this.#persistedCompileCacheClosures.delete(
        compileCachePersistenceSlotKey(space, entryIdentity, cacheOpts),
      );
      return await this.#tryColdLoadByIdentity(
        entryIdentity,
        symbol,
        space,
        cacheOpts,
      );
    }

    const cachedModules: CachedCompiledModule[] = [...closure].map(
      ([identity, doc]) => ({
        identity,
        filename: doc.filename,
        code: doc.code,
        // A data entry rides the closure to reach the compartment; the record
        // builder takes it out before anything reads `code` as a body.
        ...(doc.kind === "data" ? { isData: true } : {}),
        ...(doc.sourceMap !== undefined
          ? { sourceMap: doc.sourceMap as never }
          : {}),
        // Fix B: carry the precomputed record surface (parse fallback if absent).
        ...(doc.exportNames !== undefined
          ? { exportNames: doc.exportNames }
          : {}),
        ...(doc.starTargetSpecs !== undefined
          ? { starTargetSpecs: doc.starTargetSpecs }
          : {}),
        ...(doc.importSpecs !== undefined
          ? { importSpecs: doc.importSpecs }
          : {}),
        // The spans naming the lines this body's coverage probes stand for.
        ...(doc.patternCoverageSpans !== undefined
          ? { patternCoverageSpans: doc.patternCoverageSpans }
          : {}),
        ...(doc.builderSourceSites !== undefined
          ? { builderSourceSites: doc.builderSourceSites }
          : {}),
        imports: doc.imports
          .filter((i) =>
            !i.specifier.startsWith(ROOT_LINK_SPECIFIER) &&
            !i.specifier.startsWith(SOURCE_ROOT_SPECIFIER) &&
            !i.specifier.startsWith(DATA_FILE_SPECIFIER)
          )
          .map((i) => ({ specifier: i.specifier, targetIdentity: i.identity })),
      }),
    );

    try {
      // Source-free: no sourceFiles. Sub-patterns fall back to identity.
      // Bodies came from the integrity-gated compiled-set read
      // (`loadCompiledClosure`, `requiredIntegrity`), so trust the CFC label and
      // skip redundant SES body re-verification.
      const result = await harness.evaluateCachedModules(
        cachedModules,
        entryIdentity,
        {
          trustedBodies: true,
          ...(patternCoverage ? { patternCoverage } : {}),
        },
      );
      const pattern = this.#patternFromMain(result, symbol, entryIdentity);
      this.#failedCompileCacheRecoveries.delete(
        compileCacheRecoveryKey(space, entryIdentity),
      );
      this.#esmCacheStats.byIdentityHits++;
      return pattern;
    } catch (error) {
      logger.warn("load-pattern-by-identity-miss", () => [
        `entry=${entryIdentity}`,
        `symbol=${symbol}`,
        String(error),
      ]);
      return await this.#tryColdLoadByIdentity(
        entryIdentity,
        symbol,
        space,
        cacheOpts,
      );
    }
  }

  /** Record one deterministic compile failure for this session/version. */
  #memoizeColdLoadFailure(
    space: MemorySpace,
    entryIdentity: string,
    runtimeVersion: string | undefined,
    reason: string,
  ): void {
    this.#coldLoadNegativeMemo.add(
      `${space}\0${entryIdentity}`,
      runtimeVersion,
    );
    logger.error("load-pattern-by-identity-negative-memo", () => [
      `entry=${entryIdentity}`,
      `space=${space}`,
      `runtimeVersion=${runtimeVersion}`,
      `reason=${reason}`,
      "further loads are suppressed for this runtime session/version",
    ]);
  }

  /**
   * Runtime-version-bump recovery for a content-addressed pattern reference:
   * recompile from the verified source closure, letting fabric imports refetch
   * their own source closures from the same space.
   */
  async #tryColdLoadByIdentity(
    entryIdentity: string,
    symbol: string,
    space: MemorySpace,
    cacheOpts?: { runtimeVersion: string },
  ): Promise<Pattern | undefined> {
    const harness = this.runtime.harness;
    const readTx = this.runtime.edit();
    let sourceDocs;
    try {
      sourceDocs = await loadVerifiedSourceClosure(
        this.runtime,
        space,
        entryIdentity,
        readTx,
      );
    } finally {
      readTx.abort?.("load-pattern-by-identity source read complete");
    }
    if (sourceDocs === undefined) return undefined;
    const entry = sourceDocs.get(entryIdentity);
    if (entry === undefined) return undefined;
    const moduleDelegations = moduleDelegationsFromDocs(sourceDocs);
    const sourceRoots = sourcePackagePaths(
      entry,
      sourceDocs,
      SOURCE_ROOT_SPECIFIER,
    );
    const dataFiles = sourcePackagePaths(
      entry,
      sourceDocs,
      DATA_FILE_SPECIFIER,
    );

    const sourceFiles: Source[] = [...sourceDocs.values()].map((doc) => ({
      name: doc.filename,
      contents: doc.code,
    }));

    const patternCoverage = this.#patternCoverageFor();
    try {
      const compiled = await harness.compileResolvedToRecordGraph(
        sourceFiles,
        entry.filename,
        {
          fabricImports: { space },
          ...(patternCoverage ? { patternCoverage } : {}),
          ...(sourceRoots.length === 0 ? {} : { sourceRoots }),
          ...(dataFiles.length === 0 ? {} : { dataFiles }),
        },
      );
      if (compiled.entryIdentity !== entryIdentity) {
        throw deterministicCompileError(
          `source closure recompiled to ${compiled.entryIdentity}, expected ${entryIdentity}`,
        );
      }
      const cachedModules: CachedCompiledModule[] = compiled.modules.map(
        (module) => ({
          identity: module.identity,
          filename: module.filename,
          code: module.js,
          ...(module.isData ? { isData: true } : {}),
          ...(module.sourceMap !== undefined
            ? { sourceMap: module.sourceMap as never }
            : {}),
          // The spans naming the lines this body's coverage probes stand for.
          ...(module.patternCoverageSpans !== undefined
            ? { patternCoverageSpans: module.patternCoverageSpans }
            : {}),
          ...(module.builderSourceSites !== undefined
            ? { builderSourceSites: module.builderSourceSites }
            : {}),
          imports: module.imports,
        }),
      );
      const result = await harness.evaluateCachedModules(
        cachedModules,
        entryIdentity,
        {
          sourceFiles,
          ...(dataFiles.length === 0 ? {} : { dataFiles }),
          ...(patternCoverage ? { patternCoverage } : {}),
        },
      );
      const pattern = this.#patternFromMain(result, symbol, entryIdentity);
      if (cacheOpts !== undefined) {
        const recoveryKey = compileCacheRecoveryKey(space, entryIdentity);
        const repair = this.#persistCompileCacheTracked(
          space,
          compiled.modules,
          entryIdentity,
          cacheOpts,
          moduleDelegations,
        ).then(() => {
          this.#failedCompileCacheRecoveries.delete(recoveryKey);
        }).catch((error) => {
          this.#failedCompileCacheRecoveries.add(recoveryKey);
          logger.warn("load-pattern-by-identity-writeback-failed", () => [
            `entry=${entryIdentity}`,
            `symbol=${symbol}`,
            String(error),
          ]);
        });
        this.#compileCacheWrites.add(repair);
        repair.finally(() => this.#compileCacheWrites.delete(repair));
      }
      return pattern;
    } catch (error) {
      logger.warn("load-pattern-by-identity-source-miss", () => [
        `entry=${entryIdentity}`,
        `symbol=${symbol}`,
        String(error),
      ]);
      // Only engine/local failures explicitly classified after source-closure
      // verification are memoized. Resolution and evaluation errors carry no
      // marker and are retried on the next call.
      // Coverage compilation calls into the runtime-supplied collector while
      // the compiler is running. A collector failure is not a pure function of
      // source bytes, so coverage-enabled attempts deliberately fail open.
      if (
        patternCoverage === undefined &&
        isDeterministicCompileFailure(error)
      ) {
        this.#memoizeColdLoadFailure(
          space,
          entryIdentity,
          cacheOpts?.runtimeVersion,
          String(error),
        );
      }
      return undefined;
    }
  }

  /**
   * Build a pattern object from an evaluation result by export `symbol`, with
   * NO program attached (the source-free by-identity path). Mirrors
   * `#patternFromEvaluation` minus `setPatternProgram` — recovery of the program
   * happens by identity via the source closure, not from the pattern object.
   */
  #patternFromMain(
    result: EvaluateResult,
    symbol: string,
    entryIdentity: string,
  ): Pattern {
    this.registerEvaluatedModules(result);
    const { main } = result;
    if (!main) {
      throw new Error("Pattern compilation produced no exports.");
    }
    // Usually an authored export, but a map/filter/flatMap `op` reloads by a
    // transformer HOIST symbol (`__cfReg`, e.g. `__cfPattern_1`) that is not an
    // export — `registerEvaluatedModules` above indexed it, so resolve it there.
    const pattern =
      (symbol in main
        ? main[symbol]
        : this.#addressableByIdentity.get(entryIdentity)?.get(symbol)) as
          | Pattern
          | undefined;
    if (!pattern) {
      throw new Error(
        `No "${symbol}" export or hoist registration found in compiled pattern.`,
      );
    }
    // Trust gate stays pattern-only on purpose: the forward
    // `{ identity, symbol }` ref for a NON-pattern artifact was already set by
    // `registerEvaluatedModules` via `#indexArtifact`, whose gate is the wider
    // `isTrustedBuilderArtifact` — narrowing `#indexArtifact` would drop
    // exported lift/handler forward refs (the gap Codex flagged on an earlier
    // revision of #3912).
    if (isTrustedPattern(pattern)) {
      setArtifactEntryRef(pattern, { identity: entryIdentity, symbol });
    }
    return pattern;
  }

  /**
   * Index every module of a just-evaluated ESM bundle by its content identity
   * (CT-1623). Lets `loadPatternByIdentity` reuse a sub-pattern module already
   * evaluated as part of its parent's bundle — no storage read, no SES re-eval.
   *
   * Public because it is the shared indexing step every path that RUNS a
   * just-evaluated pattern must perform: the runtime's own load path calls it via
   * `#patternFromEvaluation`, and the namespace load seam `compileAndRegisterModules`
   * (used by the CLI test harness and the multi-user worker) calls it too.
   * Skipping it leaves anonymous map/filter/flatMap ops un-indexed, so
   * `getArtifactEntryRef` misses and the op falls back to its embedded graph
   * instead of the content-addressed canonical artifact — the CT-1811 defer
   * corruption. It is deliberately NOT folded into `Engine.compileAndEvaluateModules`,
   * since that primitive is also used to inspect serialized/verified output
   * without running (engine unit tests), where the side effect of stamping entry
   * refs is unwanted — `compileAndRegisterModules` is the fused seam callers use to
   * run. Idempotent per identity (re-registering refreshes the LRU), so paths that
   * already registered are unaffected.
   */
  registerEvaluatedModules(result: EvaluateResult): void {
    const byId = result.exportsByIdentity;
    if (byId) {
      assertNoReservedHoistExports(byId);
      for (const [identity, exports] of byId) {
        // `#modulesByIdentity` keeps the whole namespace for MODULE reuse on a
        // by-identity reload (a separate concern from artifact addressing).
        // Refresh insertion order (Map is FIFO-ordered) so eviction is ~LRU.
        this.#modulesByIdentity.delete(identity);
        this.#modulesByIdentity.set(identity, { exports });
        // Index each exported builder artifact for addressing by its export name.
        // (Reload relies on this so a sub-pattern's result cell loads BY IDENTITY
        // instead of cold-recompiling — CT-1623.)
        const sourcePath = result.sourcePathByIdentity?.get(identity);
        for (const exportName of Object.keys(exports)) {
          if (exportName === "__esModule") continue;
          this.#indexArtifact(identity, exportName, exports[exportName]);
          // Stamp where it came from. The by-identity reload path attaches no
          // program on purpose, so this is the only record a nested pattern
          // keeps of its own file — and without it nothing downstream can say
          // which source a live sub-pattern corresponds to.
          if (sourcePath !== undefined) {
            setPatternSourcePath(exports[exportName], sourcePath);
          }
        }
      }
      while (this.#modulesByIdentity.size > this.#maxEvaluatedModuleCacheSize) {
        const oldest = this.#modulesByIdentity.keys().next().value;
        if (oldest === undefined) break;
        this.#modulesByIdentity.delete(oldest);
      }
    }

    // Index the hoisted + non-exported top-level builder artifacts the module
    // registered via `__cfReg`, into the SAME index as the exports above.
    const sink = result.registrationsByIdentity;
    if (sink) {
      for (const [identity, entries] of sink) {
        const sourcePath = result.sourcePathByIdentity?.get(identity);
        for (const [symbol, value] of entries) {
          this.#indexArtifact(identity, symbol, value);
          if (sourcePath !== undefined) setPatternSourcePath(value, sourcePath);
        }
      }
    }

    // No eviction for `#addressableByIdentity` — the artifact index is
    // session-lifetime (see its declaration): sync by-identity resolution
    // must keep working for every module evaluated this session.
  }

  /**
   * Index one content-addressed builder artifact `{ identity, symbol } -> value`,
   * the single path that populates both the reverse `#addressableByIdentity` and
   * forward `valueToEntryRef` maps — whether the value came from a module's
   * `__cfReg` registration (hoists + non-exported top-level) or its exports.
   *
   * SECURITY: only a genuine trusted builder artifact (pattern / lift / handler —
   * `isTrustedBuilderArtifact`) is indexed. A `__cf_data`-forged plain object
   * carries no brand and is dropped, so it can never acquire a content-addressed
   * reference or be handed back as a trusted value. (Cross-module forgery is
   * independently impossible: identity is a content hash, so a module can only
   * register under its own bytes' identity.)
   */
  #indexArtifact(
    identity: string,
    symbol: string,
    value: unknown,
  ): void {
    if (!isTrustedBuilderArtifact(value)) return;
    // Reverse index. Overwrite an existing symbol so a re-evaluation of the
    // same identity resolves to the FRESH artifact instance, not a stale one
    // from a prior eval.
    let bucket = this.#addressableByIdentity.get(identity);
    if (!bucket) {
      bucket = new Map<string, unknown>();
      this.#addressableByIdentity.set(identity, bucket);
    }
    bucket.set(symbol, value);
    // Forward map is FIRST-WRITE-WINS, deliberately, on two grounds:
    //   - One artifact instance legitimately reachable under two refs (e.g. both
    //     a `__cfReg` entry AND an export, or set first by `#patternFromMain`)
    //     keeps a single canonical `{ identity, symbol }` for serialization.
    //   - The reverse index above already overwrote, so by-identity LOOKUP
    //     (`artifactFromIdentitySync`) is always fresh; the forward ref only
    //     needs to be A valid name for the value, not the newest.
    // Caveat: if the SAME instance is later re-registered under a CHANGED
    // identity (a content edit that preserves object identity across re-eval),
    // the forward ref stays pinned to the original — acceptable because the
    // value is, by content identity, the original. `getArtifactEntryRef`
    // consumers tolerate this (it resolves to a real, addressable artifact).
    setArtifactEntryRef(value, { identity, symbol });
    // Note: content-addressed CFC provenance is recorded by the engine at
    // evaluation time (Engine.#recordModuleProvenance) — the single home, so it
    // covers every load path, not only ones routed through this indexing.
  }

  /**
   * Resolve a content-addressed `{ identity, symbol }` reference to its live
   * builder artifact, synchronously, from the single in-memory index — or
   * `undefined` on a miss (the module never evaluated in this session; callers
   * fall back to a stored graph vintage or an async source reload). The index
   * is session-lifetime, so a hit is guaranteed for any module evaluated this
   * session — what the list builtins rely on to resolve a map/filter/flatMap
   * `op` during a synchronous Action without an embedded fallback graph.
   */
  artifactFromIdentitySync(
    identity: string,
    symbol: string,
  ): unknown {
    // Returns the live builder artifact (pattern / lift / handler). Callers know
    // the kind they expect from the symbol's origin and cast accordingly.
    return this.#addressableByIdentity.get(identity)?.get(symbol);
  }

  /**
   * Best-effort authored program for a live pattern by its content
   * `{ identity, symbol }` — the source-viewing debug surface
   * (`getPatternSources`). Returns the program rather than its files, so a
   * caller can tell which entries carry data. Returns undefined when the
   * pattern is not live in this session or carries no program (e.g. a
   * source-free by-identity reload); callers degrade gracefully (omit the
   * pattern). Source-bearing cross-session recovery is the source-doc
   * closure's job, not this.
   */
  getPatternProgramBySync(
    identity: string,
    symbol: string,
  ): RuntimeProgram | undefined {
    const pattern = this.artifactFromIdentitySync(identity, symbol) as
      | Pattern
      | undefined;
    if (!pattern) return undefined;
    return getPatternProgram(pattern);
  }

  /**
   * Reuse a module already evaluated in-memory (as part of any bundle) for a
   * by-identity load, skipping the storage closure read + SES re-evaluation.
   * Returns undefined on a miss so the caller falls back to the cache path.
   */
  #patternFromEvaluatedModule(
    entryIdentity: string,
    symbol: string,
  ): Pattern | undefined {
    const cached = this.#modulesByIdentity.get(entryIdentity);
    if (!cached) return undefined;
    // The symbol is usually an authored export, but a map/filter/flatMap `op`
    // result cell references a transformer HOIST (`__cfReg`, e.g. `__cfPattern_1`)
    // which is NOT a module export — it lives in the artifact index. Resolving it
    // there (instead of falling through to a cold source recompile) is what keeps
    // a reloaded op compile-free (CT-1623).
    const pattern =
      (symbol in cached.exports
        ? cached.exports[symbol]
        : this.#addressableByIdentity.get(entryIdentity)?.get(symbol)) as
          | Pattern
          | undefined;
    if (!pattern || !isTrustedPattern(pattern)) return undefined;
    // Refresh recency.
    this.#modulesByIdentity.delete(entryIdentity);
    this.#modulesByIdentity.set(entryIdentity, cached);
    setArtifactEntryRef(pattern, { identity: entryIdentity, symbol });
    return pattern;
  }

  /**
   * Write the module set into `space` and AWAIT it, tracking the in-flight
   * promise in `#compileCacheWrites` + `#pendingCacheWriteBacks` (so graceful
   * shutdown and closure replication can observe it). A failure PROPAGATES and
   * fails the compile: refs-only pattern JSON makes a durable closure in `space`
   * part of the compilation contract.
   */

  /** Attach the trigger's §2b carriage ONLY for a write target FOREIGN
   * to the serving manager's home space (OW31 seat S-A): home-space
   * writebacks and every client writeback stay plain bookkeeping —
   * byte-identical to before. */
  #writebackDelegationFor(
    space: MemorySpace,
    delegated: WritebackDelegation | undefined,
  ): { delegated?: WritebackDelegation } {
    const home = this.runtime.storageManager.servingHomeSpace;
    return delegated !== undefined && home !== undefined && space !== home
      ? { delegated }
      : {};
  }

  async #persistCompileCacheTracked(
    space: MemorySpace,
    modules: CacheableModule[],
    entryIdentity: string,
    opts: { runtimeVersion: string },
    moduleDelegations: ModuleDelegationMap = new Map(),
    delegated?: WritebackDelegation,
  ): Promise<void> {
    const persistenceSlotKey = compileCachePersistenceSlotKey(
      space,
      entryIdentity,
      opts,
    );
    const closureSignature = compileCacheClosureSignature(
      modules.map((module) => module.identity),
      moduleDelegations,
    );
    const predecessor = this.#inProgressCompileCacheWrites.get(
      persistenceSlotKey,
    );
    if (predecessor?.closureSignature === closureSignature) {
      await predecessor.persistence;
      return;
    }

    // Install the successor as the slot's tail before waiting for its
    // predecessor. Replication snapshots `#pendingCacheWriteBacks`, so every
    // write already requested when that snapshot is taken must be represented.
    const persistence = (async () => {
      await predecessor?.persistence.catch(() => {});

      if (
        predecessor === undefined &&
        this.#persistedCompileCacheClosures.get(persistenceSlotKey) ===
          closureSignature
      ) {
        const stored = await this.#hasStoredCompileCacheClosure(
          space,
          modules,
          entryIdentity,
          opts,
          moduleDelegations,
        ).catch(() => false);
        if (stored) {
          this.#failedCompileCacheRecoveries.delete(
            compileCacheRecoveryKey(space, entryIdentity),
          );
          this.#recordPersistedClosureSpaces(
            [entryIdentity, ...modules.map((module) => module.identity)],
            space,
          );
          return;
        }
        this.#persistedCompileCacheClosures.delete(persistenceSlotKey);
      }

      // A writer a test supplied stands in for the write-back.
      await (this.#compileCacheWriter === undefined
        ? this.#writeBackCompileCache(
          space,
          modules,
          entryIdentity,
          opts,
          moduleDelegations,
          delegated,
        )
        : this.#compileCacheWriter(
          space,
          modules,
          entryIdentity,
          opts,
          moduleDelegations,
          delegated,
        ));
      this.#persistedCompileCacheClosures.set(
        persistenceSlotKey,
        closureSignature,
      );
      this.#failedCompileCacheRecoveries.delete(
        compileCacheRecoveryKey(space, entryIdentity),
      );
      this.#recordPersistedClosureSpaces(
        [entryIdentity, ...modules.map((module) => module.identity)],
        space,
      );
    })();
    this.#inProgressCompileCacheWrites.set(persistenceSlotKey, {
      closureSignature,
      persistence,
    });
    this.#compileCacheWrites.add(persistence);
    this.#pendingCacheWriteBacks.add(persistence);
    try {
      await persistence;
    } finally {
      const current = this.#inProgressCompileCacheWrites.get(
        persistenceSlotKey,
      );
      if (current?.persistence === persistence) {
        this.#inProgressCompileCacheWrites.delete(persistenceSlotKey);
      }
      this.#compileCacheWrites.delete(persistence);
      this.#pendingCacheWriteBacks.delete(persistence);
    }
  }

  async #hasStoredCompileCacheClosure(
    space: MemorySpace,
    modules: readonly CacheableModule[],
    entryIdentity: string,
    opts: { runtimeVersion: string },
    moduleDelegations: ModuleDelegationMap = new Map(),
  ): Promise<boolean> {
    const readTx = this.runtime.edit();
    try {
      const source = await loadVerifiedSourceClosure(
        this.runtime,
        space,
        entryIdentity,
        readTx,
      );
      if (source === undefined) return false;
      for (
        const identity of expectedSourceClosureIdentities(
          modules,
          entryIdentity,
        )
      ) {
        if (!source.has(identity)) return false;
      }
      if (!closureIncludesModuleDelegations(source, moduleDelegations)) {
        return false;
      }

      const compiled = await loadCompiledClosure(
        this.runtime,
        space,
        entryIdentity,
        opts,
        readTx,
      );
      if (
        isPatternCoverageCacheRuntimeVersion(opts.runtimeVersion) &&
        !cacheEntriesIncludePatternCoverage(compiled.values())
      ) {
        return false;
      }
      if (!closureIncludesModuleDelegations(compiled, moduleDelegations)) {
        return false;
      }
      return modules.every((module) => compiled.has(module.identity));
    } finally {
      readTx.abort?.("compile-cache persistence check complete");
    }
  }

  async #persistSourceCacheTracked(
    space: MemorySpace,
    modules: CacheableModule[],
    entryIdentity: string,
    moduleDelegations: ModuleDelegationMap = new Map(),
    delegated?: WritebackDelegation,
  ): Promise<void> {
    const writeBack = this.#writeBackSourceCache(
      space,
      modules,
      entryIdentity,
      moduleDelegations,
      delegated,
    );
    this.#compileCacheWrites.add(writeBack);
    this.#pendingCacheWriteBacks.add(writeBack);
    try {
      await writeBack;
      this.#recordPersistedClosureSpaces(
        [entryIdentity, ...modules.map((module) => module.identity)],
        space,
      );
    } finally {
      this.#compileCacheWrites.delete(writeBack);
      this.#pendingCacheWriteBacks.delete(writeBack);
    }
  }

  async #writeBackSourceCache(
    space: MemorySpace,
    modules: CacheableModule[],
    entryIdentity: string,
    moduleDelegations: ModuleDelegationMap = new Map(),
    delegated?: WritebackDelegation,
  ): Promise<void> {
    const writebackStart = performance.now();
    await this.#syncSourceCacheWriteTargets(space, modules);
    let committedModuleDelegations = moduleDelegations;
    const { error } = await this.runtime.editWithRetry((tx) => {
      // Compile-cache writeback is runtime-internal bookkeeping
      // (serving-loop.md §3d, RULED 2026-08-05): it runs from async
      // compile flows with no scheduler run around it, and a SERVING
      // runtime's wave refuses unstamped seals — unstamped, the cache
      // never heals server-side and every cold load recompiles. No-op
      // on the OFF arm and for plain clients. A FOREIGN-space writeback
      // additionally carries the triggering run's §2b delegated
      // carriage (OW31 seat S-A) — without it the wave's accept gate
      // refuses the crossing.
      this.runtime.stampServerRun(tx, {
        actionId: `compile-cache/source-writeback/${entryIdentity}`,
        kind: "bookkeeping",
        ...this.#writebackDelegationFor(space, delegated),
      });
      committedModuleDelegations = writeSourceDocs(
        this.runtime,
        space,
        modules,
        entryIdentity,
        tx,
        moduleDelegations,
      );
    });
    logger.time(writebackStart, "compile-cache", "source-writeback");
    if (error) {
      logger.error("source-cache-writeback-failed", () => [
        `entry=${entryIdentity}`,
        error.message,
      ]);
      throw throwableStorageError(error);
    }
    this.runtime.registerModuleDelegations(space, committedModuleDelegations);
  }

  /**
   * Write the source + compiled document sets for an emitted module set into
   * `space`, on its own transaction, independent of the caller's. Uses
   * `editWithRetry` so a commit conflict (e.g. the cache write racing the
   * pattern's own space writes) retries rather than silently dropping the
   * entry. A final failure throws because persisted refs-only pattern JSON
   * requires a durable closure behind every `$patternRef`.
   */
  async #writeBackCompileCache(
    space: MemorySpace,
    modules: CacheableModule[],
    entryIdentity: string,
    opts: { runtimeVersion: string },
    moduleDelegations: ModuleDelegationMap = new Map(),
    delegated?: WritebackDelegation,
  ): Promise<void> {
    const writebackStart = performance.now();
    await this.#syncCompileCacheWriteTargets(space, modules, opts);
    // The closure is committed in CHUNKS of bounded module count rather than
    // one all-or-nothing transaction. A stale-refs recovery (compiler output
    // change over a pre-existing space) re-writes the entire closure; as a
    // single commit, a session killed mid-write persisted NOTHING and every
    // retrying session redid the whole write — under aggressive client
    // timeouts no session ever landed it (the estuary first-open outage).
    // Each committed chunk survives interruption: docs are content-addressed,
    // dependencies commit first and the ENTRY doc last, so an interrupted
    // write-back never persists the entry of a namespace that lacked one —
    // and an absent entry is exactly the load paths' miss test, so every
    // producible partial prefix reads as a plain cache miss. (That is the
    // precise guarantee; the loaders do NOT fail closed on missing
    // descendants — see planCompileCacheWriteChunks for why the
    // entry-present/descendant-missing state, not producible by this
    // ordering, still degrades to a clean recompile.) The next session's
    // re-write diffs already-durable docs to nothing. The `persistence`
    // promise callers await still resolves only after ALL chunks are
    // durable, so the "refs-only pattern JSON requires a durable closure"
    // contract is unchanged.
    const { chunks, extraRoots } = planCompileCacheWriteChunks(
      modules,
      entryIdentity,
    );
    // Union of the per-chunk effective delegation maps. Chunks partition the
    // module set and the effective map is keyed per module, so the union over
    // all chunks equals the single-transaction effective map exactly.
    const committedModuleDelegations = new Map<string, ReadonlySet<string>>();
    for (const chunk of chunks) {
      // The write-back re-writes source docs whose values carry quote-cell
      // indirections (one derived doc per import edge). On a cold replica
      // those derived docs are unknown, and each commit attempt discovers
      // exactly ONE of them: the engine rejects on the first stale read,
      // editWithRetry pulls that doc, and only then does the next attempt's
      // diff reach the following one (CT-1824, live-traced on the browser
      // rig — the system-app closure re-write conflicts on ~24 pre-existing
      // edge docs, one per round). Convergence therefore needs one retry per
      // pre-existing derived doc; the general DEFAULT_MAX_RETRIES (5)
      // exhausts long before that and the cache never heals, so every later
      // cold boot recompiles. Budget by the chunk's edge count (source +
      // compiled edge docs) with slack. Rounds are bounded by actual
      // conflicts — a conflict-free write-back still commits on the first
      // attempt — so the ceiling is only paid during recovery after a
      // compiler-version bump.
      //
      // The historical fixed floor (16) is NOT applied per chunk — that would
      // multiply the minimum by chunk count (six low-edge chunks = 96 retries
      // vs the old closure-wide 16; Codex review on #5094). A single-chunk
      // write-back keeps the exact historical budget; a multi-chunk one gives
      // each chunk its edge-proportional share plus one round of slack, so
      // the aggregate stays >= 16 (8 * 2 chunks minimum) without the 16x
      // chunk-count inflation.
      const importEdges = chunk.reduce((n, m) => n + m.imports.length, 0);
      const writebackMaxRetries = chunks.length === 1
        ? Math.max(16, 2 * importEdges + 8)
        : 2 * importEdges + 8;
      let chunkDelegations: ModuleDelegationMap = new Map();
      const { error } = await this.runtime.editWithRetry((tx) => {
        // Bookkeeping stamp, same §3d reason as writeBackSourceCache
        // above (the triage-confirmed second offender: this writeback
        // refused unstamped on the serving runtime).
        this.runtime.stampServerRun(tx, {
          actionId: `compile-cache/writeback/${entryIdentity}`,
          kind: "bookkeeping",
          ...this.#writebackDelegationFor(space, delegated),
        });
        chunkDelegations = writeSourceAndCompiledDocs(
          this.runtime,
          space,
          chunk,
          entryIdentity,
          { ...opts, moduleDelegations, extraRoots },
          tx,
        );
      }, writebackMaxRetries);
      if (error) {
        logger.time(writebackStart, "compile-cache", "writeback");
        logger.error("compile-cache-writeback-failed", () => [
          `entry=${entryIdentity}`,
          `chunkModules=${chunk.length}/${modules.length}`,
          error.message,
        ]);
        throw throwableStorageError(error);
      }
      for (const [identity, predecessors] of chunkDelegations) {
        committedModuleDelegations.set(identity, predecessors);
      }
    }
    logger.time(writebackStart, "compile-cache", "writeback");
    this.runtime.registerModuleDelegations(space, committedModuleDelegations);
  }

  // Write-target pre-syncs carry the one-hop edge selector (CT-1848): a
  // schema-less sync delivers only the root doc, leaving the per-edge element
  // docs unknown to the replica, so a re-write of pre-existing docs touches
  // them blind and conflicts one engine round per edge (the CT-1824 loop).
  // With the edge docs materialized up front the write-back diffs against
  // true state and commits on the first attempt; the retry budget in
  // writeBackCompileCache remains as a backstop. Same-microtask syncs batch
  // into a single server round trip.
  async #syncSourceCacheWriteTargets(
    space: MemorySpace,
    modules: readonly CacheableModule[],
  ): Promise<void> {
    await Promise.all(
      modules.map((module) =>
        this.runtime.getCell(
          space,
          sourceDocKey(module.identity),
          WRITE_TARGET_EDGE_SYNC_SCHEMA,
        ).sync()
      ),
    );
  }

  async #syncCompileCacheWriteTargets(
    space: MemorySpace,
    modules: readonly CacheableModule[],
    opts: { runtimeVersion: string },
  ): Promise<void> {
    await Promise.all(
      modules.flatMap((module) => [
        this.runtime.getCell(
          space,
          sourceDocKey(module.identity),
          WRITE_TARGET_EDGE_SYNC_SCHEMA,
        ).sync(),
        this.runtime.getCell(
          space,
          compiledDocKey(opts.runtimeVersion, module.identity),
          WRITE_TARGET_EDGE_SYNC_SCHEMA,
        ).sync(),
      ]),
    );
  }

  // Resolve a Pattern from an evaluate result.
  #patternFromEvaluation(
    result: EvaluateResult,
    program: RuntimeProgram,
    entryIdentity?: string,
  ): Pattern {
    this.registerEvaluatedModules(result);
    const { main } = result;
    if (!main) {
      throw new Error("Pattern compilation produced no exports.");
    }
    const exportName = program.mainExport ?? "default";
    if (!(exportName in main)) {
      throw new Error(
        `No "${exportName}" export found in compiled pattern.`,
      );
    }
    const pattern = main[exportName] as Pattern;
    // Only a trusted (builder-produced) entry pattern receives rehydration
    // metadata; a forged pattern-shaped export gets none and so cannot
    // masquerade as a verified-loaded pattern in the side-tables.
    if (isTrustedPattern(pattern)) {
      setPatternProgram(pattern, program);
      if (entryIdentity) {
        setArtifactEntryRef(pattern, {
          identity: entryIdentity,
          symbol: exportName,
        });
      }
    }
    return pattern;
  }

  /**
   * The content-addressed `{ identity, symbol }` reference for a builder artifact
   * (pattern / lift / handler), if known (learned when the module loads). Lets
   * callers persist a result cell's reference so the artifact reloads straight
   * from the compiled cache. Returns undefined for an artifact with no recorded
   * module provenance (host-trusted or dynamically created).
   */
  getArtifactEntryRef(
    value: object,
  ): { identity: string; symbol: string } | undefined {
    // Exact object first, then the derivation root — handled by the
    // module-level store (refs are indexed post-evaluation, after build-time
    // copies were made, so the lookup walks the derivation link lazily).
    return getArtifactEntryRef(value);
  }

  /**
   * Compile a pattern from source, or return a cached/in-flight result.
   * Provides single-flight deduplication based on program content.
   *
   * @param input - Source code string or RuntimeProgram to compile
   * @param space - When provided, routes the ESM compile through the
   *   content-addressed cell cache in this space (CT-1623): cold compiles write
   *   their module set back, and subsequent loads of the same source skip the TS
   *   compile. Without it (e.g. tests), compilation is uncached as before.
   * @returns The compiled pattern (from cache, in-flight compilation, or new)
   */
  compileOrGetPattern(
    input: string | RuntimeProgram,
    space?: MemorySpace,
  ): Promise<Pattern> {
    // Normalize to RuntimeProgram
    let program: RuntimeProgram;
    if (typeof input === "string") {
      program = {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: input }],
      };
    } else {
      program = input;
    }

    // Content-hash key (createRef as a pure digest, NOT a cell id). Identical
    // source returns the same compiled instance; concurrent compiles share one
    // evaluation.
    const dedupeKey = toURI(createRef({ src: program }, "pattern source"));

    const cached = this.#compiledByContent.get(dedupeKey);
    if (cached) {
      // Refresh recency (FIFO ~LRU).
      this.#compiledByContent.delete(dedupeKey);
      this.#compiledByContent.set(dedupeKey, cached);
      // The content cache is space-agnostic, but a piece persisted in `space`
      // needs the source/compiled closure IN that space to reload by
      // { identity, symbol } in a fresh runtime (the meta-cell fallback is
      // gone). When this hit serves a different space than the one we first
      // compiled into, replicate the closure there — cheap (no TS recompile),
      // with persistence writes deduplicated and tracked in `#compileCacheWrites`.
      if (space && cached.space && space !== cached.space) {
        this.replicatePatternToSpace(cached.pattern, space, cached.space);
      }
      return Promise.resolve(cached.pattern);
    }

    const inProgress = this.#inProgressCompilations.get(dedupeKey);
    if (inProgress) return inProgress;

    // Pass the cell-cache context when a space is available so nested/dynamic
    // compiles benefit from the cache too.
    const compilationPromise = this.compilePattern(
      program,
      space ? { space } : undefined,
    )
      .then((pattern) => {
        this.#compiledByContent.set(dedupeKey, { pattern, space });
        while (this.#compiledByContent.size > MAX_EVALUATED_MODULE_CACHE_SIZE) {
          const oldest = this.#compiledByContent.keys().next().value;
          if (oldest === undefined) break;
          this.#compiledByContent.delete(oldest);
        }
        return pattern;
      })
      .finally(() => {
        this.#inProgressCompilations.delete(dedupeKey);
      });

    this.#inProgressCompilations.set(dedupeKey, compilationPromise);
    return compilationPromise;
  }

  /**
   * Best-effort authored source program for a stored pattern by its content
   * `entryIdentity` — recovered from the verified `pattern:<identity>` source-doc
   * closure in `space`. The single-source replacement for the deleted meta
   * cell's `program`: the source docs are written (awaited) by every cold
   * compile, so this returns the same bytes that produced the identity. `main`
   * is the executable entry document's authored filename. `sourceRoots` names
   * retained source entry points such as attached tests, and `dataFiles` names
   * attached data files. Returns `undefined` when no verified source closure
   * exists in the space.
   */
  async getPatternSourceProgramByIdentity(
    entryIdentity: string,
    space: MemorySpace,
    destinationSpace?: MemorySpace,
  ): Promise<
    {
      main: string;
      files: { name: string; contents: string }[];
      sourceRoots?: string[];
      dataFiles?: string[];
    } | undefined
  > {
    const readTx = this.runtime.edit();
    let sourceDocs;
    try {
      sourceDocs = await loadVerifiedSourceClosure(
        this.runtime,
        space,
        entryIdentity,
        readTx,
      );
      if (
        sourceDocs !== undefined && destinationSpace !== undefined &&
        destinationSpace !== space
      ) {
        for (const identity of sourceDocs.keys()) {
          const sourceId = this.runtime.getCell(
            space,
            sourceDocKey(identity),
            undefined,
            readTx,
          ).getAsNormalizedFullLink().id;
          // An UnknownCfcMetadataVersionError propagates, deliberately: a
          // stored-source envelope this build cannot interpret must not
          // read as unprotected source.
          const metadata = readStoredCfcMetadata(readTx, {
            space,
            id: sourceId,
          });
          const prohibited = sourceCfcMetadataProhibitsCrossSpaceCopy(
            metadata,
          );
          if (prohibited) {
            throw new Error(
              `pattern source ${entryIdentity} carries CFC provenance that ` +
                `cannot be copied from ${space} to ${destinationSpace}`,
            );
          }
        }
      }
    } finally {
      readTx.abort?.("get-pattern-source-files read complete");
    }
    if (sourceDocs === undefined) return undefined;
    const entry = sourceDocs.get(entryIdentity);
    if (entry === undefined) return undefined;
    const sourceRoots = sourcePackagePaths(
      entry,
      sourceDocs,
      SOURCE_ROOT_SPECIFIER,
    ).filter((filename) => filename.startsWith("/"));
    const dataFiles = sourcePackagePaths(
      entry,
      sourceDocs,
      DATA_FILE_SPECIFIER,
    ).filter((filename) => filename.startsWith("/"));
    // Return only the AUTHORED files — the faithful replacement for the old
    // meta-cell `program`. The verified source closure also contains
    // runtime-INJECTED helper modules (e.g. `cfc.ts`), which the compiler
    // resolves WITHOUT the `/<id>/` prefix (see Engine), so authored files are
    // exactly the grounded (`/`-prefixed) ones. The full closure is used for
    // recompilation via `loadVerifiedSourceClosure` directly, not here.
    return {
      main: entry.filename,
      files: [...sourceDocs.values()]
        .filter((doc) => doc.filename.startsWith("/"))
        .map((doc) => ({
          name: doc.filename,
          contents: doc.code,
        })),
      ...(sourceRoots.length === 0 ? {} : { sourceRoots }),
      ...(dataFiles.length === 0 ? {} : { dataFiles }),
    };
  }

  /**
   * Attach an optional, NON-NORMATIVE annotation link to a pattern's entry
   * source doc (`pattern:<identity>` in `space`). Annotations are product
   * metadata (a name doc, a spec doc, lineage); the runtime NEVER reads them for
   * execution, and `verifySourceDocs` excludes them from the content hash — an
   * annotated and an unannotated doc verify identically. First-write semantics
   * are last-write-wins per `key` (the merge below). Fire-and-forget at the
   * caller's discretion.
   */
  async annotatePattern(
    entryIdentity: string,
    space: MemorySpace,
    key: string,
    link: unknown,
  ): Promise<void> {
    await this.runtime.editWithRetry((tx) => {
      // Bookkeeping stamp, same §3d reason as the cache writebacks
      // above: fire-and-forget async write, no scheduler run around it.
      this.runtime.stampServerRun(tx, {
        actionId: `pattern-annotate/${entryIdentity}`,
        kind: "bookkeeping",
      });
      const cell = this.runtime.getCell<
        { annotations?: Record<string, unknown> }
      >(
        space,
        sourceDocKey(entryIdentity),
        undefined,
        tx,
      );
      const current = cell.get();
      const annotations = {
        ...(isObjectOrArray(current?.annotations) ? current!.annotations : {}),
        [key]: link,
      };
      cell.key("annotations").set(annotations);
    });
  }
}
