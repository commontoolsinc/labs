import { getLogger } from "@commonfabric/utils/logger";
import type { Source } from "@commonfabric/js-compiler";
import { compilerStack } from "./harness/deferred-compiler-stack.ts";
import { Module, Pattern } from "./builder/types.ts";
import {
  brandTrustedPattern,
  getArtifactEntryRef,
  getPatternProgram,
  isTrustedBuilderArtifact,
  isTrustedPattern,
  resolveOriginal,
  setArtifactEntryRef,
  setDurableArtifactEntryRef,
  setPatternProgram,
} from "./builder/pattern-metadata.ts";
import type { MemorySpace, Runtime } from "./runtime.ts";
import type { PatternCoverageCollector } from "./pattern-coverage.ts";
import { createRef } from "./create-ref.ts";
import type {
  CacheableModule,
  CompiledModuleArtifact,
  EvaluateResult,
  Exports,
  TypeScriptHarnessProcessOptions,
} from "./harness/types.ts";
import { RuntimeProgram } from "./harness/types.ts";
import type { CachedCompiledModule } from "./sandbox/module-record-compiler.ts";
import type {
  CommitError,
  IExtendedStorageTransaction,
  IStorageManager,
  NativeStorageCommitOperation,
} from "./storage/interface.ts";
import { ExtendedStorageTransaction } from "./storage/extended-storage-transaction.ts";
import { V2StorageTransaction } from "./storage/v2-transaction.ts";
import { toDocumentPath } from "@commonfabric/memory/v2";
import {
  buildSourceDocs,
  type CompiledDoc,
  compiledDocKey,
  deriveModuleDelegations,
  getCompileCacheRuntimeVersion,
  loadCompiledClosure,
  loadVerifiedSourceClosure,
  type ModuleDelegationMap,
  moduleDelegationsFromDocs,
  ROOT_LINK_SPECIFIER,
  type SourceDoc,
  sourceDocKey,
  WRITE_TARGET_EDGE_SYNC_SCHEMA,
  writeCompiledDocs,
  writeSourceAndCompiledDocs,
  writeSourceDocs,
} from "./compilation-cache/cell-cache.ts";
import {
  isFabricImportSpecifier,
  parseFabricRef,
  pinnedIdentity,
} from "./sandbox/fabric-import-specifier.ts";
import { fromURI, toURI } from "./uri-utils.ts";
import { isRecord } from "@commonfabric/utils/types";
import { interleaveCompileYield } from "./harness/compile-interleave.ts";

const logger = getLogger("pattern-manager");

// Bound for the in-memory identity->module cache. Higher than the pattern cache
// because a single bundle contributes one entry per module (a big space-root
// bundle is ~10 modules), and entries are cheap (a reference to an already-live
// namespace).
const MAX_EVALUATED_MODULE_CACHE_SIZE = 1000;
const PATTERN_COVERAGE_CACHE_VARIANT = "pattern-coverage";

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

interface VerifiedArtifactClosure {
  readonly sourceDocs: Map<string, SourceDoc>;
  readonly compiledDocs?: Map<string, CompiledDoc>;
  readonly runtimeVersion?: string;
}

export class PatternManager {
  // Single-flight dedup + in-memory result cache for `compileOrGetPattern`,
  // keyed by a content hash of the program (NOT a cell id, NOT the retired
  // patternId) so identical source returns one shared, already-compiled pattern
  // instance. The hash is computed with `createRef` purely as a stable digest
  // function — no `pattern:` cell is ever minted. Bounded FIFO to cap memory.
  private inProgressCompilations = new Map<string, Promise<Pattern>>();
  // Single-flight dedup for the expensive tail of `loadArtifactByIdentity`
  // (storage closure read + SES evaluation), keyed by `${space}\0${identity}`.
  // Boot references the same entry several times at once (one load per
  // referencing piece/system pattern); without this every concurrent miss ran
  // its own full closure evaluation — measured as 4 identical 9-module SES
  // evals per cold worker boot, the multiplier behind most of the per-module
  // boot-floor buckets. Followers await the leader and then resolve their own
  // symbol from the indexes the leader's evaluation populated — the same path
  // a load arriving after completion takes.
  private inProgressByIdentityLoads = new Map<
    string,
    Promise<boolean>
  >();
  // Content-hash → { compiled pattern, the space its closure was first written
  // into }. The space is tracked so a cross-space cache hit can replicate the
  // source/compiled closure into the requested space (see compileOrGetPattern):
  // identical source dedupes the expensive TS compile, but every space holding
  // a piece that points at the pattern still needs the closure persisted there
  // to reload by { identity, symbol } in a fresh runtime.
  private compiledByContent = new Map<
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
  // populated by ONE path (`indexArtifact`) from BOTH a module's `__cfReg`
  // registrations (hoists + non-exported top-level) AND its exports — so callers
  // never look in two places. SESSION-LIFETIME, deliberately unbounded (design
  // § Open questions 2, resolved): the sync resolution the list builtins and
  // refs-only pattern JSON depend on must never lose an artifact whose module
  // evaluated this session. Entries are live builder artifacts of evaluated
  // modules — the same order of retention the engine's strong implementation
  // index (E1) already committed to for their implementation functions.
  private addressableByIdentity = new Map<string, Map<string, unknown>>();
  /**
   * Explicitly trusted, session-only identities for hand-built patterns.
   * These have no durable source closure by construction, so exact-space
   * storage authority does not apply to their in-session resume path.
   */
  private sessionOnlyArtifactIdentities = new Set<string>();
  // Successful module evaluations, retained for the session independently of
  // the bounded namespace cache below. This is also the negative-symbol cache:
  // once one evaluation indexed every trusted export and __cfReg binding, an
  // absent/untrusted symbol is definitively absent and must not trigger another
  // storage read + SES evaluation.
  private evaluatedArtifactIdentities = new Set<string>();
  // Bound for the module-NAMESPACE cache below (`modulesByIdentity`) only; its
  // misses recover through the async storage-backed load. Instance field so
  // tests can shrink it.
  private maxEvaluatedModuleCacheSize = MAX_EVALUATED_MODULE_CACHE_SIZE;
  // ESM content-addressed compile-cache instrumentation.
  private esmCacheStats = { hits: 0, misses: 0, byIdentityHits: 0 };
  // In-memory identity -> module-namespace cache (CT-1623). Populated for EVERY
  // module of an evaluated ESM bundle (keyed by prefix-free content identity),
  // so a by-identity load of a sub-pattern reuses the already-live module from
  // its parent's bundle instead of re-reading the closure from storage and
  // re-evaluating it in SES. Content-addressed, so a hit is always the same
  // bytes — never stale. Bounded (FIFO) to cap memory.
  private modulesByIdentity = new Map<string, { exports: Exports }>();
  // In-flight compiled-cache write-backs; awaited by flushCompileCacheWrites()
  // for graceful shutdown / deterministic tests. Cold compile write-backs are
  // awaited by compilePattern; recovery/replication paths may still run in the
  // background.
  private compileCacheWrites = new Set<Promise<unknown>>();
  // Closure write-backs that replication must observe before reading its
  // origin space. Tracked separately because the replication promise also
  // lives in `compileCacheWrites` and cannot await itself.
  private pendingCacheWriteBacks = new Set<Promise<unknown>>();
  // Maps each storage slot written during this PatternManager session to its
  // complete module set. One slot can hold only one closure shape at a time.
  private persistedCompileCacheClosures = new Map<string, string>();
  // Writes to one storage slot are serialized. Requests for the same closure
  // share the write that is already running.
  private inProgressCompileCacheWrites = new Map<
    string,
    { closureSignature: string; persistence: Promise<void> }
  >();
  // A best-effort identity recovery that failed to persist skips the in-memory
  // artifact shortcuts on the next load so storage recovery runs again.
  private failedCompileCacheRecoveries = new Set<string>();
  // `${entryIdentity}\0${space}` fire-and-forget compatibility replications
  // already kicked off this session (see `replicatePatternToSpace`). An entry
  // is removed on failure so the next child creation retries.
  private replicatedClosures = new Set<string>();
  // Single-flight awaited artifact-closure ensures. The source participates in
  // the key: two trusted source spaces may race to repair the same destination,
  // but callers naming the exact same transport share one verification/copy.
  // Settled entries are always removed. Successful calls subsequently hit the
  // exact-space availability map; failed calls remain retryable.
  private inProgressArtifactClosureReplications = new Map<
    string,
    Promise<void>
  >();
  // Exact-space durability authority for Factory@1 writers. A live artifact
  // index proves only that code evaluated in this session; it says nothing
  // about which space can cold-load the content-addressed source closure. This
  // map is populated only after an awaited persistence succeeds or a complete
  // storage-backed source closure is verified in that exact space.
  private availableArtifactIdentities = new Map<MemorySpace, Set<string>>();
  // Verified source closures retained for synchronous by-value publication.
  // A cold source still enters through the async loader and populates this map
  // before its containing commit reaches the wire.
  private artifactPublicationModules = new Map<string, CacheableModule[]>();

  constructor(readonly runtime: Runtime) {}

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
    return { ...this.esmCacheStats };
  }

  /**
   * Whether `identity` has a verified durable source closure in
   * `artifactSpace`. This is runner-owned provenance: neither Factory@1 wire
   * state nor a pattern's execution `spaceSelector` can populate it.
   */
  isArtifactAvailableInSpace(
    identity: string,
    artifactSpace: MemorySpace,
  ): boolean {
    return this.availableArtifactIdentities.get(artifactSpace)?.has(identity) ??
      false;
  }

  /** Trusted in-session source space for an already-verified artifact. */
  artifactSourceSpace(
    identity: string,
    destination?: MemorySpace,
  ): MemorySpace | undefined {
    for (const [space, identities] of this.availableArtifactIdentities) {
      if (space !== destination && identities.has(identity)) return space;
    }
    return undefined;
  }

  private artifactPublicationKey(
    space: MemorySpace,
    identity: string,
  ): string {
    return `${space}\0${identity}`;
  }

  private cacheArtifactPublicationModules(
    space: MemorySpace,
    identity: string,
    modules: CacheableModule[],
  ): void {
    this.artifactPublicationModules.set(
      this.artifactPublicationKey(space, identity),
      modules,
    );
  }

  /**
   * Retain the exact forward import closure rooted at every verified module.
   *
   * A compiled entry can expose factories from any module in its graph. Once
   * that graph is verified, each such factory is warm and must publish without
   * introducing an asynchronous readiness boundary. The original entry keeps
   * the complete verified set, including synthetic extra roots. Other modules
   * retain independently rooted forward closures so publishing a dependency
   * directly does not include importer-only siblings.
   */
  private cacheArtifactPublicationClosures(
    space: MemorySpace,
    modules: CacheableModule[],
    entryIdentity: string,
  ): void {
    const modulesByIdentity = new Map(
      modules.map((module) => [module.identity, module]),
    );
    for (const rootIdentity of modulesByIdentity.keys()) {
      if (rootIdentity === entryIdentity) {
        this.cacheArtifactPublicationModules(space, rootIdentity, modules);
        continue;
      }
      const reachable = new Set<string>();
      const pending = [rootIdentity];
      while (pending.length > 0) {
        const identity = pending.pop()!;
        if (reachable.has(identity)) continue;
        const module = modulesByIdentity.get(identity);
        if (module === undefined) continue;
        reachable.add(identity);
        for (const imp of module.imports) {
          if (
            !imp.specifier.startsWith(ROOT_LINK_SPECIFIER) &&
            modulesByIdentity.has(imp.targetIdentity)
          ) {
            pending.push(imp.targetIdentity);
          }
        }
      }
      this.cacheArtifactPublicationModules(
        space,
        rootIdentity,
        modules.filter((module) => reachable.has(module.identity)),
      );
    }
  }

  /**
   * Build the source-document ensures that make a by-value Factory@1 durable
   * in `toSpace`. Warm verified source returns synchronously. A cold source
   * returns a promise, which the v2 replica holds behind the already-visible
   * speculative containing commit.
   */
  prepareArtifactPublication(
    entryIdentity: string,
    fromSpace: MemorySpace,
    toSpace: MemorySpace,
  ):
    | readonly NativeStorageCommitOperation[]
    | Promise<readonly NativeStorageCommitOperation[]> {
    if (this.isArtifactAvailableInSpace(entryIdentity, toSpace)) return [];

    const cached = this.artifactPublicationModules.get(
      this.artifactPublicationKey(fromSpace, entryIdentity),
    );
    if (cached !== undefined) {
      return this.buildArtifactPublicationOperations(
        cached,
        entryIdentity,
        toSpace,
      );
    }

    return (async () => {
      await Promise.allSettled([...this.pendingCacheWriteBacks]);
      const closure = await this.loadVerifiedArtifactClosure(
        fromSpace,
        entryIdentity,
        undefined,
      );
      if (closure === undefined) {
        throw new Error(
          `Artifact closure ${entryIdentity} is unavailable in source space ${fromSpace}`,
        );
      }
      const modules = this.modulesFromVerifiedArtifactClosure(closure);
      this.cacheArtifactPublicationClosures(
        fromSpace,
        modules,
        entryIdentity,
      );
      return this.buildArtifactPublicationOperations(
        modules,
        entryIdentity,
        toSpace,
      );
    })();
  }

  /** Grant destination-space authority only after the atomic wire commit. */
  noteArtifactPublicationConfirmed(
    entryIdentity: string,
    toSpace: MemorySpace,
  ): void {
    this.noteArtifactClosureAvailable(toSpace, [entryIdentity]);
  }

  private buildArtifactPublicationOperations(
    modules: CacheableModule[],
    entryIdentity: string,
    toSpace: MemorySpace,
  ): readonly NativeStorageCommitOperation[] {
    // Build against an intentionally empty replica so every artifact document
    // (including derived import-edge documents) is represented as an explicit
    // ensure even when the real destination happens to be warm locally.
    const emptyStorage = {
      open: (space: MemorySpace) => ({
        replica: {
          did: () => space,
          get: () => undefined,
          getDocument: () => undefined,
        },
      }),
    } as unknown as IStorageManager;
    const base = new V2StorageTransaction(emptyStorage);
    const draft = new ExtendedStorageTransaction(base);
    try {
      writeSourceDocs(this.runtime, toSpace, modules, entryIdentity, draft);
      const native = base.getNativeCommit(toSpace);
      if (native === undefined) {
        throw new Error(
          `Artifact closure ${entryIdentity} produced no publication documents`,
        );
      }
      return native.operations.map((operation) => {
        if (operation.op === "delete" || operation.op === "ensure") {
          throw new Error(
            `Artifact closure ${entryIdentity} produced unexpected ${operation.op} draft operation`,
          );
        }
        return {
          op: "ensure" as const,
          id: operation.id,
          type: operation.type,
          scope: operation.scope,
          value: operation.value,
          // Product annotations and runtime-maintained CFC labels are not part
          // of the module's content identity and must not create false
          // mismatches against a pre-existing destination artifact.
          ignore: [
            toDocumentPath(["value", "annotations"]),
            toDocumentPath(["cfc"]),
          ],
        };
      });
    } finally {
      draft.abort("artifact publication draft complete");
    }
  }

  /** Fail closed unless the exact containing space can cold-load `identity`. */
  assertArtifactAvailableInSpace(
    identity: string,
    artifactSpace: MemorySpace,
  ): void {
    if (!this.isArtifactAvailableInSpace(identity, artifactSpace)) {
      throw new Error(
        `Factory artifact ${identity} is not available in space ${artifactSpace}`,
      );
    }
  }

  private noteArtifactClosureAvailable(
    artifactSpace: MemorySpace,
    identities: Iterable<string>,
  ): void {
    let available = this.availableArtifactIdentities.get(artifactSpace);
    if (available === undefined) {
      available = new Set<string>();
      this.availableArtifactIdentities.set(artifactSpace, available);
    }
    for (const identity of identities) {
      available.add(identity);
      // A factory can be evaluated and indexed before the containing commit
      // publishes its closure. Commit confirmation is the point at which that
      // exact content identity becomes durable authority, so upgrade every
      // already-live symbol without requiring a re-evaluation.
      const indexed = this.addressableByIdentity.get(identity);
      if (indexed !== undefined) {
        for (const [symbol, value] of indexed) {
          setDurableArtifactEntryRef(value, { identity, symbol });
        }
      }
    }
  }

  /**
   * Load and verify the complete source closure that can back one artifact in
   * `artifactSpace`, including pinned Fabric imports. Source documents omit
   * Fabric edges deliberately, so verifying only the entry's linked closure
   * would miss separately rooted imported artifacts that compiled-cache
   * closures include. Every such root must itself verify in the same space.
   */
  private async loadVerifiedArtifactSourceClosure(
    artifactSpace: MemorySpace,
    entryIdentity: string,
    tx: IExtendedStorageTransaction,
  ): Promise<Map<string, SourceDoc> | undefined> {
    const verified = new Map<string, SourceDoc>();
    const visitedRoots = new Set<string>();
    const pendingRoots = [entryIdentity];

    while (pendingRoots.length > 0) {
      const rootIdentity = pendingRoots.shift()!;
      if (visitedRoots.has(rootIdentity)) continue;
      visitedRoots.add(rootIdentity);

      const closure = await loadVerifiedSourceClosure(
        this.runtime,
        artifactSpace,
        rootIdentity,
        tx,
      );
      if (closure === undefined) return undefined;

      for (const [identity, doc] of closure) {
        if (!verified.has(identity)) verified.set(identity, doc);
        for (const imp of fabricImportRefsFromSource(doc)) {
          if (!visitedRoots.has(imp.targetIdentity)) {
            pendingRoots.push(imp.targetIdentity);
          }
        }
      }
    }

    // Verification is the single authority for retaining publication source.
    // Every caller that successfully loads a closure — compiled-cache hits,
    // runtime-version recovery, ordinary pattern compilation, and explicit
    // closure verification — now warms the same synchronous publication path.
    this.cacheArtifactPublicationClosures(
      artifactSpace,
      this.modulesFromVerifiedArtifactClosure({ sourceDocs: verified }),
      entryIdentity,
    );
    return verified;
  }

  /** Resolve once all in-flight compiled-cache write-backs have settled. */
  async flushCompileCacheWrites(): Promise<void> {
    await Promise.allSettled([...this.compileCacheWrites]);
  }

  /**
   * Attach a rehydration `program` to a hand-built pattern object (one with no
   * module-scope entry ref). The only surviving job of the old
   * `registerPattern`: source-bearing tests/builtins that construct a Pattern in
   * hand can associate its source so `getPatternProgram` (and thus
   * `getPatternFilesBySync`) returns it. No-op when the pattern already carries a
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
    this.sessionOnlyArtifactIdentities.add(ref.identity);
    this.indexArtifact(ref.identity, ref.symbol, pattern);
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
    const identity = `keyless:${fromURI(toURI(createRef(root, "pattern")))}`;
    const ref = { identity, symbol: "default" };
    this.associatePatternIdentity(root, ref);
    return ref;
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
   * Closure replication is fire-and-forget (tracked in `compileCacheWrites`,
   * awaited by `flushCompileCacheWrites`): the child is loadable in-session
   * regardless, this only affects fresh runtimes. A failure is logged and
   * retried on the next child creation — never on the caller's commit path.
   */
  replicatePatternToSpace(
    pattern: Pattern | Module,
    toSpace: MemorySpace,
    fromSpace: MemorySpace,
  ): void {
    if (toSpace === fromSpace) return;

    const entryRef = this.getArtifactEntryRef(pattern);
    if (!entryRef) return;
    const dedupeKey = `${entryRef.identity}\0${toSpace}`;
    if (this.replicatedClosures.has(dedupeKey)) return;
    this.replicatedClosures.add(dedupeKey);
    const replication = this.ensureArtifactClosureInSpace(
      entryRef.identity,
      fromSpace,
      toSpace,
    ).catch((error) => {
      this.replicatedClosures.delete(dedupeKey);
      logger.error("closure-replication-failed", () => [
        `entry=${entryRef.identity}`,
        `from=${fromSpace}`,
        `to=${toSpace}`,
        String(error),
      ]);
    });
    this.compileCacheWrites.add(replication);
    replication.finally(() => this.compileCacheWrites.delete(replication));
  }

  /**
   * Await exact-space durability for one content-addressed builder artifact.
   * Concurrent calls for the same `(identity, source, destination)` share one
   * flight. A successful cross-space call either verifies an already-complete
   * destination closure or copies source first, then the runtime-versioned
   * compiled set, and verifies the complete destination before granting any
   * availability. Same-space calls verify and mark without writing.
   *
   * Failures never grant availability and settled flights are removed, so a
   * caller can repair missing storage and retry the same operation.
   */
  ensureArtifactClosureInSpace(
    entryIdentity: string,
    fromSpace: MemorySpace,
    toSpace: MemorySpace,
  ): Promise<void> {
    // A prior successful cross-space ensure is already the required proof.
    // Same-space calls deliberately re-enter verification: this public seam is
    // also how a fresh manager learns authority for pre-existing storage.
    if (
      fromSpace !== toSpace &&
      this.isArtifactAvailableInSpace(entryIdentity, toSpace)
    ) {
      return Promise.resolve();
    }

    const dedupeKey = `${fromSpace}\0${toSpace}\0${entryIdentity}`;
    const inProgress = this.inProgressArtifactClosureReplications.get(
      dedupeKey,
    );
    if (inProgress !== undefined) return inProgress;

    const replication = this.replicateClosures(
      entryIdentity,
      fromSpace,
      toSpace,
    );
    this.inProgressArtifactClosureReplications.set(dedupeKey, replication);
    const clearReplication = () => {
      if (
        this.inProgressArtifactClosureReplications.get(dedupeKey) ===
          replication
      ) {
        this.inProgressArtifactClosureReplications.delete(dedupeKey);
      }
    };
    void replication.then(clearReplication, clearReplication);
    return replication;
  }

  /**
   * Verify or copy one complete artifact closure. Fabric-import source edges
   * are deliberately not persisted as ordinary source links, so
   * `loadVerifiedArtifactClosure` roots each pinned dependency separately and
   * validates that the compiled graph covers that entire combined source set.
   */
  private async replicateClosures(
    entryIdentity: string,
    fromSpace: MemorySpace,
    toSpace: MemorySpace,
  ): Promise<void> {
    // The origin-space closure may have been produced by THIS session's cold
    // compile, whose write-back is itself fire-and-forget and may not have
    // committed yet. A lost race would throw here — and for a handler-created
    // child (one space per profile) nothing re-fires the released dedupe key,
    // leaving that child permanently unloadable. Await the in-flight
    // write-backs first. (Their own set, not flushCompileCacheWrites: this
    // replication promise is tracked there and would await itself.)
    await Promise.allSettled([...this.pendingCacheWriteBacks]);
    const runtimeVersion = moduleByteCacheRuntimeVersion(
      await getCompileCacheRuntimeVersion(),
      { patternCoverage: this.runtime.patternCoverage !== undefined },
    );
    const existing = await this.loadVerifiedArtifactClosure(
      toSpace,
      entryIdentity,
      runtimeVersion,
    );
    if (existing !== undefined) {
      this.noteArtifactClosureAvailable(toSpace, existing.sourceDocs.keys());
      return;
    }

    if (fromSpace === toSpace) {
      throw new Error(
        `Artifact closure ${entryIdentity} is unavailable in space ${toSpace}`,
      );
    }

    const origin = await this.loadVerifiedArtifactClosure(
      fromSpace,
      entryIdentity,
      runtimeVersion,
    );
    if (origin === undefined) {
      throw new Error(
        `Artifact closure ${entryIdentity} is unavailable in source space ${fromSpace}`,
      );
    }
    const modules = this.modulesFromVerifiedArtifactClosure(origin);

    // Source is the runtime-version-independent recovery authority. Make the
    // complete source set durable before attempting the compiled cache so a
    // compiled-write failure leaves a safe, retryable source-first partial
    // copy, never a compiled-only destination.
    await this.writeBackSourceCache(toSpace, modules, entryIdentity);
    if (runtimeVersion !== undefined) {
      await this.writeBackCompiledCache(
        toSpace,
        modules,
        entryIdentity,
        { runtimeVersion },
      );
    }

    const copied = await this.loadVerifiedArtifactClosure(
      toSpace,
      entryIdentity,
      runtimeVersion,
    );
    if (
      copied === undefined ||
      [...origin.sourceDocs.keys()].some((identity) =>
        !copied.sourceDocs.has(identity)
      )
    ) {
      throw new Error(
        `Artifact closure ${entryIdentity} failed verification in destination space ${toSpace}`,
      );
    }
    this.noteArtifactClosureAvailable(toSpace, copied.sourceDocs.keys());
  }

  private async loadVerifiedArtifactClosure(
    artifactSpace: MemorySpace,
    entryIdentity: string,
    runtimeVersion: string | undefined,
  ): Promise<VerifiedArtifactClosure | undefined> {
    const readTx = this.runtime.edit();
    try {
      // Source verification recomputes module identities with the default ("")
      // runtimeFingerprint — the same default every compile path uses today.
      // If a non-empty fingerprint is threaded into compilation, it must also
      // be threaded through this verifier.
      const sourceDocs = await this.loadVerifiedArtifactSourceClosure(
        artifactSpace,
        entryIdentity,
        readTx,
      );
      if (sourceDocs === undefined || !sourceDocs.has(entryIdentity)) {
        return undefined;
      }
      const sourceClosure = { sourceDocs } satisfies VerifiedArtifactClosure;
      if (runtimeVersion === undefined) return sourceClosure;

      const compiledDocs = await loadCompiledClosure(
        this.runtime,
        artifactSpace,
        entryIdentity,
        { runtimeVersion },
        readTx,
      );
      if (
        !compiledDocs.has(entryIdentity) ||
        [...sourceDocs.keys()].some((identity) =>
          !compiledDocs.has(identity)
        ) ||
        [...compiledDocs.keys()].some((identity) =>
          !sourceDocs.has(identity)
        ) ||
        (isPatternCoverageCacheRuntimeVersion(runtimeVersion) &&
          !cacheEntriesIncludePatternCoverage(compiledDocs.values()))
      ) {
        return undefined;
      }
      return { sourceDocs, compiledDocs, runtimeVersion };
    } finally {
      readTx.abort?.("artifact-closure verification complete");
    }
  }

  private modulesFromVerifiedArtifactClosure(
    closure: VerifiedArtifactClosure,
  ): CacheableModule[] {
    const modules: CacheableModule[] = [];
    for (const [identity, doc] of closure.sourceDocs) {
      const compiled = closure.compiledDocs?.get(identity);
      if (closure.runtimeVersion !== undefined && compiled === undefined) {
        throw new Error(`compiled doc missing for ${identity}`);
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
        ...(compiled?.policyManifests !== undefined
          ? { policyManifests: compiled.policyManifests }
          : {}),
        // Rebuild real internal and pinned Fabric import edges. Synthetic cache
        // root links are recomputed by the write functions for the complete set.
        imports: uniqueCacheableImports([
          ...doc.imports
            .filter((imp) => !imp.specifier.startsWith(ROOT_LINK_SPECIFIER))
            .map((imp) => ({
              specifier: imp.specifier,
              targetIdentity: imp.identity,
            })),
          ...fabricImportRefsFromSource(doc),
        ]),
      });
    }
    return modules;
  }

  private async loadPreviousSourceClosure(
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
      return await this.compileViaCellCache(program, cacheCtx);
    }
    const patternCoverage = this.patternCoverageFor();
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
      program.files,
    );
    return this.patternFromEvaluation(result, program);
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
   * entry ref and could not participate in canonical Factory@1 identity and
   * cold materialization.
   *
   * Registration is fused with evaluation here on purpose, so it cannot be
   * forgotten — mirroring what the runtime's own `compilePattern` /
   * `patternFromEvaluation` load path does. Reach for the bare
   * `Engine.compileAndEvaluateModules` only to inspect serialized/verified output
   * *without running* (engine unit tests), where stamping entry refs is unwanted.
   */
  /**
   * The pattern-coverage collector to instrument a compile with: a per-call
   * option wins, else the runtime-level default (`RuntimeOptions.patternCoverage`).
   * Undefined leaves the compile uninstrumented.
   */
  private patternCoverageFor(
    options?: TypeScriptHarnessProcessOptions,
  ): PatternCoverageCollector | undefined {
    return options?.patternCoverage ?? this.runtime.patternCoverage;
  }

  async compileAndRegisterModules(
    program: RuntimeProgram,
    options?: TypeScriptHarnessProcessOptions,
    cacheCtx?: { space: MemorySpace },
  ): Promise<EvaluateResult> {
    const patternCoverage = this.patternCoverageFor(options);
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
    if (
      cacheCtx === undefined &&
      (byteCache === undefined || runtimeVersion === undefined)
    ) {
      const result = await this.runtime.harness.compileAndEvaluateModules(
        program,
        effectiveOptions,
      );
      this.registerEvaluatedModules(result);
      return result;
    }

    const { id, graph, mainSpecifier, entryIdentity, modules } = await this
      .runtime.harness
      .compileToRecordGraph(program, {
        ...effectiveOptions,
        ...(cacheCtx === undefined
          ? {}
          : { fabricImports: { space: cacheCtx.space } }),
        ...(byteCache === undefined || runtimeVersion === undefined ? {} : {
          precompiledModulesFor: ({ identities }) =>
            Promise.resolve(
              byteCache.getCompleteSet(runtimeVersion, identities),
            ),
        }),
      });
    if (byteCache !== undefined && runtimeVersion !== undefined) {
      byteCache.putAll(runtimeVersion, modules);
    }
    if (cacheCtx !== undefined) {
      // This full-namespace seam is used by pattern-test harnesses that need
      // named exports in addition to `main.default`. Persist the complete
      // version-independent source closure before granting durable refs; a
      // process byte-cache hit alone is only session authority.
      await this.persistSourceCacheTracked(
        cacheCtx.space,
        modules,
        entryIdentity,
      );
    }
    // Yield ahead of the synchronous SES evaluation (see compilePattern).
    await interleaveCompileYield();
    const result = this.runtime.harness.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program.files,
    );
    if (cacheCtx === undefined) {
      this.registerEvaluatedModules(result);
    } else {
      this.registerDurableEvaluatedModules(result);
    }
    return result;
  }

  /**
   * ESM compile + evaluate backed by the content-addressed cell cache in
   * `cacheCtx.space`. On a warm full hit the per-module compiled bodies are
   * reused (no TypeScript compile / transformer pipeline / SES re-verify); on a
   * miss the program is compiled and its modules are written back (source +
   * integrity-stamped compiled docs) on a fresh transaction before returning.
   */
  private async compileViaCellCache(
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
      : await this.loadPreviousSourceClosure(
        space,
        cacheCtx.previousEntryIdentity,
      );
    const patternCoverage = this.patternCoverageFor();
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
      await this.persistSourceCacheTracked(
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
        program.files,
      );
      return this.patternFromEvaluation(result, program, entryIdentity);
    }
    const cacheOpts = { runtimeVersion };

    // Fast path — warm load BY IDENTITY: if the entry's content identity is
    // already known (stored from a prior compile), load the compiled closure
    // directly and build+evaluate from it, skipping `resolve` and `compile`
    // entirely. Falls through to the compile path on any miss/incompleteness
    // (evaluateCachedModules re-verifies the graph, so an incomplete closure
    // throws and we recompile).
    if (cacheCtx.knownEntryIdentity && previousSourceDocs === undefined) {
      const byIdentity = await this.tryWarmLoadByIdentity(
        cacheCtx.knownEntryIdentity,
        space,
        cacheOpts,
        program,
      );
      if (byIdentity) {
        this.esmCacheStats.byIdentityHits++;
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
                ...(doc.policyManifests === undefined
                  ? {}
                  : { policyManifests: doc.policyManifests }),
              });
            }
            if (
              !patternCoverage ||
              cacheEntriesIncludePatternCoverage(bodies.values())
            ) {
              const sourceClosure = await this
                .loadVerifiedArtifactSourceClosure(
                  space,
                  entryIdentity,
                  readTx,
                );
              if (
                sourceClosure !== undefined &&
                identities.every((identity) => sourceClosure.has(identity))
              ) {
                this.noteArtifactClosureAvailable(
                  space,
                  sourceClosure.keys(),
                );
                warmHit = true;
                return bodies;
              }
              storageBodiesNeedingRepair = bodies;
            }
          }

          // A storage miss makes any remembered success for this slot stale.
          // The process cache can still skip compilation, but the resulting
          // closure must be written back into the space again.
          this.persistedCompileCacheClosures.delete(
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
      program.files,
    );
    logger.time(evalStart, "compile-cache", "evaluate");

    if (warmHit) {
      // The per-space storage closure was just READ from this space, i.e. it is
      // already durable here — no write-back.
      this.esmCacheStats.hits++;
    } else {
      this.esmCacheStats[compiledBodiesServed ? "hits" : "misses"]++;
    }
    if (!warmHit || moduleDelegations.size > 0) {
      // Persist the module set into this space. AWAITED: Factory@1 values carry
      // content-addressed artifact refs, so completing the write here guarantees
      // every persisted factory has a durable closure behind it (no race against
      // session end). This
      // covers BOTH a cold compile AND a process-byte-cache hit: in the latter
      // the transform-and-emit step was skipped, but this space's persisted
      // cache may be empty (e.g. a fresh space), and the by-identity reload path
      // needs the closure here. A failed write fails the compile: a persisted
      // factory would otherwise point at a closure that is not durable in
      // `space`.
      await this.persistCompileCacheTracked(
        space,
        modules,
        entryIdentity,
        cacheOpts,
        moduleDelegations,
      );
    }

    return this.patternFromEvaluation(result, program, entryIdentity);
  }

  /**
   * Resolve-free warm load: fetch the integrity-valid compiled closure for
   * `entryIdentity` and build + evaluate the pattern directly from those cached
   * bodies (no `resolve`, no `compile`). Returns the pattern, or `undefined`
   * if the closure is absent/incomplete/invalid (caller then recompiles).
   */
  private async tryWarmLoadByIdentity(
    entryIdentity: string,
    space: MemorySpace,
    cacheOpts: { runtimeVersion: string },
    program: RuntimeProgram,
  ): Promise<Pattern | undefined> {
    const harness = this.runtime.harness;
    // `cacheOpts.runtimeVersion` already selects the coverage variant, so the
    // bodies read below carry probes exactly when this is set.
    const patternCoverage = this.patternCoverageFor();
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
      logger.time(readStart, "compile-cache", "read-by-identity");
      if (closure.has(entryIdentity)) {
        sourceClosure = await this.loadVerifiedArtifactSourceClosure(
          space,
          entryIdentity,
          readTx,
        );
      }
    } finally {
      readTx.abort?.("compile-cache by-identity read complete");
    }
    if (
      !closure.has(entryIdentity) || sourceClosure === undefined ||
      ![...closure.keys()].every((identity) => sourceClosure.has(identity)) ||
      (patternCoverage !== undefined &&
        !cacheEntriesIncludePatternCoverage(closure.values()))
    ) {
      this.persistedCompileCacheClosures.delete(
        compileCachePersistenceSlotKey(space, entryIdentity, cacheOpts),
      );
      return undefined;
    }

    const cachedModules: CachedCompiledModule[] = [...closure].map(
      ([identity, doc]) => ({
        identity,
        filename: doc.filename,
        code: doc.code,
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
        // Drop the synthetic entry→root links (cfc.ts etc.); only real
        // require/export-* edges resolve module records.
        imports: doc.imports
          .filter((i) => !i.specifier.startsWith(ROOT_LINK_SPECIFIER))
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
          trustedBodies: true,
          ...(patternCoverage ? { patternCoverage } : {}),
        },
      );
      const pattern = this.patternFromEvaluation(
        result,
        program,
        entryIdentity,
      );
      this.noteArtifactClosureAvailable(space, sourceClosure.keys());
      return pattern;
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
   * Resolve a trusted builder artifact by its content-addressed module identity
   * and export/__cfReg symbol. Storage-backed evaluation is scoped to the
   * trusted artifact source space; symbol selection happens only after the one
   * identity-level evaluation has indexed every trusted builder artifact.
   */
  async loadArtifactByIdentity(
    entryIdentity: string,
    symbol: string,
    artifactSpace: MemorySpace,
  ): Promise<object | undefined> {
    const recoveryKey = compileCacheRecoveryKey(
      artifactSpace,
      entryIdentity,
    );
    const retryFailedRecovery = this.failedCompileCacheRecoveries.has(
      recoveryKey,
    );
    const sourceAvailable = this.isArtifactAvailableInSpace(
      entryIdentity,
      artifactSpace,
    ) && !retryFailedRecovery;
    // The generic live index is populated only through indexArtifact's trusted
    // builder gate. Probe the gate again here so this public API never turns a
    // corrupted/private-table value into executable authority.
    const indexed = this.addressableByIdentity.get(entryIdentity)?.get(symbol);
    if (
      (sourceAvailable ||
        this.sessionOnlyArtifactIdentities.has(entryIdentity)) &&
      indexed !== undefined && isTrustedBuilderArtifact(indexed)
    ) {
      this.esmCacheStats.byIdentityHits++;
      return indexed as object;
    }
    if (this.runtime.cfcEnforcementMode === "disabled") {
      return undefined;
    }
    // In-memory fast path (CT-1623): the module may already be live from a
    // parent bundle's evaluation. Reuse any trusted builder kind directly — no
    // storage closure read and no SES re-evaluation. A failed cache recovery
    // bypasses session shortcuts so storage repair is attempted again.
    const live = sourceAvailable
      ? this.artifactFromEvaluatedModule(entryIdentity, symbol)
      : undefined;
    if (live !== undefined) {
      this.esmCacheStats.byIdentityHits++;
      return live;
    }

    // A successful prior evaluation indexed every trusted export and __cfReg
    // binding. Reaching this point therefore makes this a stable negative
    // lookup; do not re-evaluate just because the requested symbol is missing
    // or names an arbitrary JavaScript export.
    if (
      sourceAvailable && this.evaluatedArtifactIdentities.has(entryIdentity)
    ) {
      return undefined;
    }

    // Single-flight the expensive tail (see `inProgressByIdentityLoads`).
    const key = `${artifactSpace}\0${entryIdentity}`;
    const pending = this.inProgressByIdentityLoads.get(key);
    if (pending === undefined) {
      const load = this.loadArtifactModuleByIdentityFromStorage(
        entryIdentity,
        artifactSpace,
      ).finally(() => this.inProgressByIdentityLoads.delete(key));
      this.inProgressByIdentityLoads.set(key, load);
      if (!await load) return undefined;
    } else {
      // Followers share the identity evaluation even when they request
      // different symbols. Preserve the old transient-failure behavior: a
      // rejected leader does not permanently poison later attempts.
      try {
        if (!await pending) return undefined;
      } catch {
        return await this.loadArtifactByIdentity(
          entryIdentity,
          symbol,
          artifactSpace,
        );
      }
    }

    const loaded = this.addressableByIdentity.get(entryIdentity)?.get(symbol);
    if (loaded !== undefined && isTrustedBuilderArtifact(loaded)) {
      return loaded as object;
    }
    return undefined;
  }

  /** Pattern-only compatibility wrapper for existing result-cell callers. */
  async loadPatternByIdentity(
    entryIdentity: string,
    symbol: string,
    space: MemorySpace,
  ): Promise<Pattern | undefined> {
    const artifact = await this.loadArtifactByIdentity(
      entryIdentity,
      symbol,
      space,
    );
    return isTrustedPattern(artifact) ? artifact : undefined;
  }

  /**
   * The storage-backed tail of {@link loadArtifactByIdentity}: closure read,
   * SES evaluation, generic artifact indexing, and cold-load recovery.
   * Callers must hold the single-flight slot for `(space, entryIdentity)`.
   */
  private async loadArtifactModuleByIdentityFromStorage(
    entryIdentity: string,
    space: MemorySpace,
  ): Promise<boolean> {
    const harness = this.runtime.harness;
    const patternCoverage = this.patternCoverageFor();
    // Select the same cached variant the compile path wrote. A coverage-on
    // runtime resumes from the instrumented closure; reading the ordinary key
    // here would serve uninstrumented bodies for an instrumented run.
    const runtimeVersion = moduleByteCacheRuntimeVersion(
      await getCompileCacheRuntimeVersion(),
      { patternCoverage: patternCoverage !== undefined },
    );
    if (runtimeVersion === undefined) {
      return await this.tryColdLoadByIdentity(entryIdentity, space);
    }
    const cacheOpts = { runtimeVersion };

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
      logger.time(readStart, "compile-cache", "load-artifact-by-identity");
      if (closure.has(entryIdentity)) {
        sourceClosure = await this.loadVerifiedArtifactSourceClosure(
          space,
          entryIdentity,
          readTx,
        );
      }
    } finally {
      readTx.abort?.("load-artifact-by-identity read complete");
    }
    if (
      !closure.has(entryIdentity) ||
      (patternCoverage !== undefined &&
        !cacheEntriesIncludePatternCoverage(closure.values()))
    ) {
      this.persistedCompileCacheClosures.delete(
        compileCachePersistenceSlotKey(space, entryIdentity, cacheOpts),
      );
      return await this.tryColdLoadByIdentity(
        entryIdentity,
        space,
        cacheOpts,
      );
    }
    if (
      sourceClosure === undefined ||
      ![...closure.keys()].every((identity) => sourceClosure!.has(identity))
    ) {
      // Compiled-only cache entries are runtime-version-specific and cannot
      // authorize a durable Factory value. Fall back to verified source; if it
      // is absent too, fail closed instead of indexing an unloadable artifact.
      return await this.tryColdLoadByIdentity(
        entryIdentity,
        space,
        cacheOpts,
      );
    }

    const cachedModules: CachedCompiledModule[] = [...closure].map(
      ([identity, doc]) => ({
        identity,
        filename: doc.filename,
        code: doc.code,
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
        imports: doc.imports
          .filter((i) => !i.specifier.startsWith(ROOT_LINK_SPECIFIER))
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
      this.registerLoadedArtifactModule(result, entryIdentity);
      this.failedCompileCacheRecoveries.delete(
        compileCacheRecoveryKey(space, entryIdentity),
      );
      this.noteArtifactClosureAvailable(space, sourceClosure.keys());
      this.esmCacheStats.byIdentityHits++;
      return true;
    } catch (error) {
      logger.warn("load-artifact-by-identity-miss", () => [
        `entry=${entryIdentity}`,
        String(error),
      ]);
      return await this.tryColdLoadByIdentity(
        entryIdentity,
        space,
        cacheOpts,
      );
    }
  }

  /**
   * Runtime-version-bump recovery for a content-addressed artifact reference:
   * recompile from the verified source closure, letting fabric imports refetch
   * their own source closures from the same space.
   */
  private async tryColdLoadByIdentity(
    entryIdentity: string,
    space: MemorySpace,
    cacheOpts?: { runtimeVersion: string },
  ): Promise<boolean> {
    const harness = this.runtime.harness;
    const readTx = this.runtime.edit();
    let sourceDocs;
    let artifactSourceDocs;
    try {
      sourceDocs = await loadVerifiedSourceClosure(
        this.runtime,
        space,
        entryIdentity,
        readTx,
      );
      if (sourceDocs !== undefined) {
        artifactSourceDocs = await this.loadVerifiedArtifactSourceClosure(
          space,
          entryIdentity,
          readTx,
        );
      }
    } finally {
      readTx.abort?.("load-artifact-by-identity source read complete");
    }
    if (sourceDocs === undefined || artifactSourceDocs === undefined) {
      return false;
    }
    const entry = sourceDocs.get(entryIdentity);
    if (entry === undefined) return false;
    const moduleDelegations = moduleDelegationsFromDocs(sourceDocs);

    const sourceFiles: Source[] = [...sourceDocs.values()].map((doc) => ({
      name: doc.filename,
      contents: doc.code,
    }));

    const patternCoverage = this.patternCoverageFor();
    try {
      const compiled = await harness.compileResolvedToRecordGraph(
        sourceFiles,
        entry.filename,
        {
          fabricImports: { space },
          ...(patternCoverage ? { patternCoverage } : {}),
        },
      );
      if (compiled.entryIdentity !== entryIdentity) {
        throw new Error(
          `source closure recompiled to ${compiled.entryIdentity}, expected ${entryIdentity}`,
        );
      }
      const cachedModules: CachedCompiledModule[] = compiled.modules.map(
        (module) => ({
          identity: module.identity,
          filename: module.filename,
          code: module.js,
          ...(module.sourceMap !== undefined
            ? { sourceMap: module.sourceMap as never }
            : {}),
          // The spans naming the lines this body's coverage probes stand for.
          ...(module.patternCoverageSpans !== undefined
            ? { patternCoverageSpans: module.patternCoverageSpans }
            : {}),
          imports: module.imports,
        }),
      );
      const result = await harness.evaluateCachedModules(
        cachedModules,
        entryIdentity,
        {
          sourceFiles,
          ...(patternCoverage ? { patternCoverage } : {}),
        },
      );
      this.registerLoadedArtifactModule(result, entryIdentity);
      this.noteArtifactClosureAvailable(space, artifactSourceDocs.keys());
      if (cacheOpts !== undefined) {
        const recoveryKey = compileCacheRecoveryKey(space, entryIdentity);
        const repair = this.persistCompileCacheTracked(
          space,
          compiled.modules,
          entryIdentity,
          cacheOpts,
          moduleDelegations,
        ).then(() => {
          this.failedCompileCacheRecoveries.delete(recoveryKey);
        }).catch((error) => {
          this.failedCompileCacheRecoveries.add(recoveryKey);
          logger.warn("load-artifact-by-identity-writeback-failed", () => [
            `entry=${entryIdentity}`,
            String(error),
          ]);
        });
        this.compileCacheWrites.add(repair);
        repair.finally(() => this.compileCacheWrites.delete(repair));
      }
      return true;
    } catch (error) {
      logger.warn("load-artifact-by-identity-source-miss", () => [
        `entry=${entryIdentity}`,
        String(error),
      ]);
      return false;
    }
  }

  /**
   * Index all trusted builder artifacts from one storage-backed evaluation.
   * Selection by export/__cfReg symbol deliberately happens afterward so one
   * identity flight serves pattern, module, handler, and negative lookups.
   */
  private registerLoadedArtifactModule(
    result: EvaluateResult,
    entryIdentity: string,
  ): void {
    // This path is reached only after a verified compiled/source closure was
    // loaded from `space`, so every indexed artifact is cold-resolvable there.
    this.registerDurableEvaluatedModules(result);
    this.evaluatedArtifactIdentities.add(entryIdentity);
    if (!result.main) {
      throw new Error("Artifact compilation produced no exports.");
    }
  }

  /**
   * Index every module of a just-evaluated ESM bundle by its content identity
   * (CT-1623). Lets `loadPatternByIdentity` reuse a sub-pattern module already
   * evaluated as part of its parent's bundle — no storage read, no SES re-eval.
   *
   * Public because it is the shared indexing step every path that RUNS a
   * just-evaluated pattern must perform: the runtime's own load path calls it via
   * `patternFromEvaluation`, and the namespace load seam `compileAndRegisterModules`
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
  // Ordinary evaluation proves an in-memory artifact but says nothing about a
  // storage closure. Keep this public seam session-only; only the private
  // storage-backed path below may unlock Factory@1 sealing.
  registerEvaluatedModules(result: EvaluateResult): void {
    this.registerEvaluatedModulesWithDurability(result, false);
  }

  /** Index artifacts whose source closure is known durable in a concrete space. */
  private registerDurableEvaluatedModules(result: EvaluateResult): void {
    this.registerEvaluatedModulesWithDurability(result, true);
  }

  private registerEvaluatedModulesWithDurability(
    result: EvaluateResult,
    durable: boolean,
  ): void {
    const byId = result.exportsByIdentity;
    if (byId) {
      for (const [identity, exports] of byId) {
        this.evaluatedArtifactIdentities.add(identity);
        // `modulesByIdentity` keeps the whole namespace for MODULE reuse on a
        // by-identity reload (a separate concern from artifact addressing).
        // Refresh insertion order (Map is FIFO-ordered) so eviction is ~LRU.
        this.modulesByIdentity.delete(identity);
        this.modulesByIdentity.set(identity, { exports });
        // Index each exported builder artifact for addressing by its export name.
        // (Reload relies on this so a sub-pattern's result cell loads BY IDENTITY
        // instead of cold-recompiling — CT-1623.)
        for (const exportName of Object.keys(exports)) {
          if (exportName === "__esModule") continue;
          this.indexArtifact(
            identity,
            exportName,
            exports[exportName],
            durable,
          );
        }
      }
      while (this.modulesByIdentity.size > this.maxEvaluatedModuleCacheSize) {
        const oldest = this.modulesByIdentity.keys().next().value;
        if (oldest === undefined) break;
        this.modulesByIdentity.delete(oldest);
      }
    }

    // Index the hoisted + non-exported top-level builder artifacts the module
    // registered via `__cfReg`, into the SAME index as the exports above.
    const sink = result.registrationsByIdentity;
    if (sink) {
      for (const [identity, entries] of sink) {
        this.evaluatedArtifactIdentities.add(identity);
        for (const [symbol, value] of entries) {
          this.indexArtifact(identity, symbol, value, durable);
        }
      }
    }

    // No eviction for `addressableByIdentity` — the artifact index is
    // session-lifetime (see its declaration): sync by-identity resolution
    // must keep working for every module evaluated this session.
  }

  /**
   * Index one content-addressed builder artifact `{ identity, symbol } -> value`,
   * the single path that populates both the reverse `addressableByIdentity` and
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
  private indexArtifact(
    identity: string,
    symbol: string,
    value: unknown,
    durable = false,
  ): void {
    if (!isTrustedBuilderArtifact(value)) return;
    // Reverse index. Overwrite an existing symbol so a re-evaluation of the
    // same identity resolves to the FRESH artifact instance, not a stale one
    // from a prior eval.
    let bucket = this.addressableByIdentity.get(identity);
    if (!bucket) {
      bucket = new Map<string, unknown>();
      this.addressableByIdentity.set(identity, bucket);
    }
    bucket.set(symbol, value);
    // Forward map is FIRST-WRITE-WINS, deliberately, on two grounds:
    //   - One artifact instance legitimately reachable under two refs (e.g. both
    //     a `__cfReg` entry AND an export, or selected after generic loading)
    //     keeps a single canonical `{ identity, symbol }` for serialization.
    //   - The reverse index above already overwrote, so by-identity LOOKUP
    //     (`artifactFromIdentitySync`) is always fresh; the forward ref only
    //     needs to be A valid name for the value, not the newest.
    // Caveat: if the SAME instance is later re-registered under a CHANGED
    // identity (a content edit that preserves object identity across re-eval),
    // the forward ref stays pinned to the original — acceptable because the
    // value is, by content identity, the original. `getArtifactEntryRef`
    // consumers tolerate this (it resolves to a real, addressable artifact).
    const ref = { identity, symbol };
    // Availability may have been confirmed before a later re-evaluation of the
    // same content identity. Once any exact space holds a verified closure, a
    // newly indexed live value may safely expose the space-neutral durable ref.
    if (durable || this.artifactSourceSpace(identity) !== undefined) {
      setDurableArtifactEntryRef(value, ref);
    } else {
      setArtifactEntryRef(value, ref);
    }
    // Note: content-addressed CFC provenance is recorded by the engine at
    // evaluation time (Engine.recordModuleProvenance) — the single home, so it
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
    return this.addressableByIdentity.get(identity)?.get(symbol);
  }

  /**
   * Best-effort authored source files for a live pattern by its content
   * `{ identity, symbol }` — the source-viewing debug surface
   * (`getPatternSources`). Returns undefined when the pattern is not live in
   * this session or carries no program (e.g. a source-free by-identity
   * reload); callers degrade gracefully (omit the pattern). Source-bearing
   * cross-session recovery is the source-doc closure's job, not this.
   */
  getPatternFilesBySync(
    identity: string,
    symbol: string,
  ): { name: string; contents: string }[] | undefined {
    const pattern = this.artifactFromIdentitySync(identity, symbol) as
      | Pattern
      | undefined;
    if (!pattern) return undefined;
    return getPatternProgram(pattern)?.files;
  }

  /** Reuse any trusted builder artifact from an already-evaluated module. */
  private artifactFromEvaluatedModule(
    entryIdentity: string,
    symbol: string,
  ): object | undefined {
    const cached = this.modulesByIdentity.get(entryIdentity);
    if (!cached) return undefined;
    // A transformer hoist is not a namespace export, so fall back to the shared
    // __cfReg/export artifact index.
    const artifact = symbol in cached.exports
      ? cached.exports[symbol]
      : this.addressableByIdentity.get(entryIdentity)?.get(symbol);
    if (!isTrustedBuilderArtifact(artifact)) return undefined;
    // Refresh recency.
    this.modulesByIdentity.delete(entryIdentity);
    this.modulesByIdentity.set(entryIdentity, cached);
    setArtifactEntryRef(artifact, { identity: entryIdentity, symbol });
    return artifact as object;
  }

  /**
   * Write the module set into `space` and AWAIT it, tracking the in-flight
   * promise in `compileCacheWrites` + `pendingCacheWriteBacks` (so graceful
   * shutdown and closure replication can observe it). A failure PROPAGATES and
   * fails the compile: refs-only pattern JSON makes a durable closure in `space`
   * part of the compilation contract.
   */
  private async persistCompileCacheTracked(
    space: MemorySpace,
    modules: CacheableModule[],
    entryIdentity: string,
    opts: { runtimeVersion: string },
    moduleDelegations: ModuleDelegationMap = new Map(),
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
    const predecessor = this.inProgressCompileCacheWrites.get(
      persistenceSlotKey,
    );
    if (predecessor?.closureSignature === closureSignature) {
      await predecessor.persistence;
      return;
    }

    // Install the successor as the slot's tail before waiting for its
    // predecessor. Replication snapshots `pendingCacheWriteBacks`, so every
    // write already requested when that snapshot is taken must be represented.
    const persistence = (async () => {
      await predecessor?.persistence.catch(() => {});

      if (
        predecessor === undefined &&
        this.persistedCompileCacheClosures.get(persistenceSlotKey) ===
          closureSignature
      ) {
        const stored = await this.hasStoredCompileCacheClosure(
          space,
          modules,
          entryIdentity,
          opts,
          moduleDelegations,
        ).catch(() => false);
        if (stored) {
          this.failedCompileCacheRecoveries.delete(
            compileCacheRecoveryKey(space, entryIdentity),
          );
          return;
        }
        this.persistedCompileCacheClosures.delete(persistenceSlotKey);
      }

      await this.writeBackCompileCache(
        space,
        modules,
        entryIdentity,
        opts,
        moduleDelegations,
      );
      this.persistedCompileCacheClosures.set(
        persistenceSlotKey,
        closureSignature,
      );
      this.failedCompileCacheRecoveries.delete(
        compileCacheRecoveryKey(space, entryIdentity),
      );
    })();
    this.inProgressCompileCacheWrites.set(persistenceSlotKey, {
      closureSignature,
      persistence,
    });
    this.compileCacheWrites.add(persistence);
    this.pendingCacheWriteBacks.add(persistence);
    try {
      await persistence;
      this.cacheArtifactPublicationClosures(space, modules, entryIdentity);
      this.noteArtifactClosureAvailable(
        space,
        modules.map((module) => module.identity),
      );
    } finally {
      const current = this.inProgressCompileCacheWrites.get(
        persistenceSlotKey,
      );
      if (current?.persistence === persistence) {
        this.inProgressCompileCacheWrites.delete(persistenceSlotKey);
      }
      this.compileCacheWrites.delete(persistence);
      this.pendingCacheWriteBacks.delete(persistence);
    }
  }

  private async hasStoredCompileCacheClosure(
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

  private async persistSourceCacheTracked(
    space: MemorySpace,
    modules: CacheableModule[],
    entryIdentity: string,
    moduleDelegations: ModuleDelegationMap = new Map(),
  ): Promise<void> {
    const writeBack = this.writeBackSourceCache(
      space,
      modules,
      entryIdentity,
      moduleDelegations,
    );
    this.compileCacheWrites.add(writeBack);
    this.pendingCacheWriteBacks.add(writeBack);
    try {
      await writeBack;
      this.cacheArtifactPublicationClosures(space, modules, entryIdentity);
      this.noteArtifactClosureAvailable(
        space,
        modules.map((module) => module.identity),
      );
    } finally {
      this.compileCacheWrites.delete(writeBack);
      this.pendingCacheWriteBacks.delete(writeBack);
    }
  }

  private async writeBackSourceCache(
    space: MemorySpace,
    modules: CacheableModule[],
    entryIdentity: string,
    moduleDelegations: ModuleDelegationMap = new Map(),
  ): Promise<void> {
    const writebackStart = performance.now();
    await this.syncSourceCacheWriteTargets(space, modules);
    let committedModuleDelegations = moduleDelegations;
    const { error } = await this.runtime.editWithRetry((tx) => {
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
   * Persist only the runtime-versioned compiled half of an already-durable
   * source-first artifact copy. The caller still verifies both halves together
   * before granting exact-space availability.
   */
  private async writeBackCompiledCache(
    space: MemorySpace,
    modules: CacheableModule[],
    entryIdentity: string,
    opts: { runtimeVersion: string },
  ): Promise<void> {
    const writebackStart = performance.now();
    await this.syncCompiledCacheWriteTargets(space, modules, opts);
    const importEdges = modules.reduce((n, m) => n + m.imports.length, 0);
    const writebackMaxRetries = Math.max(16, importEdges + 8);
    const { error } = await this.runtime.editWithRetry((tx) => {
      writeCompiledDocs(this.runtime, space, modules, entryIdentity, opts, tx);
    }, writebackMaxRetries);
    logger.time(writebackStart, "compile-cache", "compiled-writeback");
    if (error) {
      logger.error("compiled-cache-writeback-failed", () => [
        `entry=${entryIdentity}`,
        error.message,
      ]);
      throw throwableStorageError(error);
    }
  }

  /**
   * Write the source + compiled document sets for an emitted module set into
   * `space`, on its own transaction, independent of the caller's. Uses
   * `editWithRetry` so a commit conflict (e.g. the cache write racing the
   * pattern's own space writes) retries rather than silently dropping the
   * entry. A final failure throws because persisted Factory@1 values require a
   * durable closure behind every artifact ref.
   */
  private async writeBackCompileCache(
    space: MemorySpace,
    modules: CacheableModule[],
    entryIdentity: string,
    opts: { runtimeVersion: string },
    moduleDelegations: ModuleDelegationMap = new Map(),
  ): Promise<void> {
    const writebackStart = performance.now();
    await this.syncCompileCacheWriteTargets(space, modules, opts);
    // The write-back re-writes source docs whose values carry quote-cell
    // indirections (one derived doc per import edge). On a cold replica those
    // derived docs are unknown, and each commit attempt discovers exactly ONE
    // of them: the engine rejects on the first stale read, editWithRetry
    // pulls that doc, and only then does the next attempt's diff reach the
    // following one (CT-1824, live-traced on the browser rig — the system-app
    // closure re-write conflicts on ~24 pre-existing edge docs, one per
    // round). Convergence therefore needs one retry per pre-existing derived
    // doc; the general DEFAULT_MAX_RETRIES (5) exhausts long before that and
    // the cache never heals, so every later cold boot recompiles. Budget by
    // the write set's edge count (source + compiled edge docs) with slack.
    // Rounds are bounded by actual conflicts — a conflict-free write-back
    // still commits on the first attempt — so the ceiling is only paid during
    // recovery after a compiler-version bump.
    const importEdges = modules.reduce((n, m) => n + m.imports.length, 0);
    const writebackMaxRetries = Math.max(16, 2 * importEdges + 8);
    let committedModuleDelegations = moduleDelegations;
    const { error } = await this.runtime.editWithRetry((tx) => {
      committedModuleDelegations = writeSourceAndCompiledDocs(
        this.runtime,
        space,
        modules,
        entryIdentity,
        { ...opts, moduleDelegations },
        tx,
      );
    }, writebackMaxRetries);
    logger.time(writebackStart, "compile-cache", "writeback");
    if (error) {
      logger.error("compile-cache-writeback-failed", () => [
        `entry=${entryIdentity}`,
        error.message,
      ]);
      throw throwableStorageError(error);
    }
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
  private async syncSourceCacheWriteTargets(
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

  private async syncCompileCacheWriteTargets(
    space: MemorySpace,
    modules: readonly CacheableModule[],
    opts: { runtimeVersion: string },
  ): Promise<void> {
    await Promise.all([
      this.syncSourceCacheWriteTargets(space, modules),
      this.syncCompiledCacheWriteTargets(space, modules, opts),
    ]);
  }

  private async syncCompiledCacheWriteTargets(
    space: MemorySpace,
    modules: readonly CacheableModule[],
    opts: { runtimeVersion: string },
  ): Promise<void> {
    await Promise.all(
      modules.map((module) =>
        this.runtime.getCell(
          space,
          compiledDocKey(opts.runtimeVersion, module.identity),
          WRITE_TARGET_EDGE_SYNC_SCHEMA,
        ).sync()
      ),
    );
  }

  // Resolve a Pattern from an evaluate result.
  private patternFromEvaluation(
    result: EvaluateResult,
    program: RuntimeProgram,
    entryIdentity?: string,
  ): Pattern {
    if (entryIdentity === undefined) {
      this.registerEvaluatedModules(result);
    } else {
      // Callers pass an entry identity only after awaiting persistence in a
      // concrete artifact space, or after loading a verified closure from one.
      this.registerDurableEvaluatedModules(result);
    }
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
        setDurableArtifactEntryRef(pattern, {
          identity: entryIdentity,
          symbol: exportName,
        });
      }
    }
    return pattern;
  }

  /**
   * The content-addressed `{ identity, symbol }` reference for a builder artifact
   * (pattern / lift / handler), if known (learned on the ESM path). Lets callers
   * persist a result cell's reference so the artifact reloads straight from the
   * compiled cache. Returns undefined for legacy/AMD artifacts.
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

    const cached = this.compiledByContent.get(dedupeKey);
    if (cached) {
      // Refresh recency (FIFO ~LRU).
      this.compiledByContent.delete(dedupeKey);
      this.compiledByContent.set(dedupeKey, cached);
      // The content cache is space-agnostic, but a piece persisted in `space`
      // needs the source/compiled closure IN that space to reload by
      // { identity, symbol } in a fresh runtime (the meta-cell fallback is
      // gone). When this hit serves a different space than the one we first
      // compiled into, replicate the closure there — cheap (no TS recompile),
      // with persistence writes deduplicated and tracked in compileCacheWrites.
      if (space && cached.space && space !== cached.space) {
        this.replicatePatternToSpace(cached.pattern, space, cached.space);
      }
      return Promise.resolve(cached.pattern);
    }

    const inProgress = this.inProgressCompilations.get(dedupeKey);
    if (inProgress) return inProgress;

    // Pass the cell-cache context when a space is available so nested/dynamic
    // compiles benefit from the cache too.
    const compilationPromise = this.compilePattern(
      program,
      space ? { space } : undefined,
    )
      .then((pattern) => {
        this.compiledByContent.set(dedupeKey, { pattern, space });
        while (this.compiledByContent.size > MAX_EVALUATED_MODULE_CACHE_SIZE) {
          const oldest = this.compiledByContent.keys().next().value;
          if (oldest === undefined) break;
          this.compiledByContent.delete(oldest);
        }
        return pattern;
      })
      .finally(() => {
        this.inProgressCompilations.delete(dedupeKey);
      });

    this.inProgressCompilations.set(dedupeKey, compilationPromise);
    return compilationPromise;
  }

  /**
   * Best-effort authored source program for a stored pattern by its content
   * `entryIdentity` — recovered from the verified `pattern:<identity>` source-doc
   * closure in `space`. The single-source replacement for the deleted meta
   * cell's `program`: the source docs are written (awaited) by every cold
   * compile, so this returns the same bytes that produced the identity. `main`
   * is the entry document's authored filename. Returns `undefined` when no
   * verified source closure exists in the space.
   */
  async getPatternSourceProgramByIdentity(
    entryIdentity: string,
    space: MemorySpace,
  ): Promise<
    { main: string; files: { name: string; contents: string }[] } | undefined
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
    } finally {
      readTx.abort?.("get-pattern-source-files read complete");
    }
    if (sourceDocs === undefined) return undefined;
    const entry = sourceDocs.get(entryIdentity);
    if (entry === undefined) return undefined;
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
        ...(isRecord(current?.annotations) ? current!.annotations : {}),
        [key]: link,
      };
      cell.key("annotations").set(annotations);
    });
  }
}
