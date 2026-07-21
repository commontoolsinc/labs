import { getLogger } from "@commonfabric/utils/logger";
import { isRecord } from "@commonfabric/utils/types";
import { CFC_COMPILED_BY_ATOM } from "@commonfabric/api/cfc";
import type { PatternCoverageSpan } from "@commonfabric/ts-transformers";
import { normalize } from "@std/path/posix";
import { computeModuleHashes } from "../harness/module-identity.ts";
import { ensureCompilerStack } from "../harness/deferred-compiler-stack.ts";
import { deriveModuleRecordFields } from "../sandbox/module-record-compiler.ts";
import type { CacheableModule } from "../harness/types.ts";
import type { MemorySpace, Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { type Cell, isCell } from "../cell.ts";
import { snapshotQueryResult } from "../query-result-proxy.ts";
import type { JSONSchema } from "../builder/types.ts";
import { readStoredCfcMetadata } from "../cfc/metadata.ts";
import {
  isFabricImportSpecifier,
  parseFabricRef,
  pinnedIdentity,
} from "../sandbox/fabric-import-specifier.ts";
import {
  COMPILE_CACHE_RUNTIME_VERSION,
  SOURCE_COMPILE_CACHE_RUNTIME_VERSION,
} from "./compile-cache-version.ts";
import { validateCfcPolicyArtifactManifest } from "../cfc/policy.ts";

const logger = getLogger("cell-cache");

/**
 * Content-addressed compilation cache — document model and key scheme.
 *
 * Phase 4 of docs/specs/module-loading.md. The persistent cache is a pair of
 * per-module document sets stored as regular cells in the target space:
 *
 *  - **Source set** `pattern:<identity>` — authored TypeScript, keyed by the
 *    per-module Merkle identity (`computeModuleHashes`). Runtime-version
 *    independent.
 *  - **Compiled set** `compileCache:<runtimeVersion>/<identity>` — verified
 *    compiled JS, keyed by `(runtimeVersion, identity)`.
 *
 * Each document records its `code`, authored `filename`, and the resolved
 * internal `imports` (`{ specifier, identity }`) — the identity is what the
 * document's sigil link points at (`sourceDocKey`/`compiledDocKey` of the
 * dependency). This module owns the pure key/identity/verification logic; the
 * cell read/write + link wiring layer builds on it.
 */

/** A resolved internal import edge of a cached module. */
export interface ModuleImportRef {
  /** Authored import specifier, e.g. `"./util.ts"`. */
  readonly specifier: string;
  /** Content-addressed identity of the imported module's document. */
  readonly identity: string;
}

/**
 * Per-module update authority: a module identity maps to the predecessor
 * identities whose writer authority it may exercise. Values are cumulative;
 * save paths merge them with the document already stored under the
 * content-addressed key.
 */
export type ModuleDelegationMap = ReadonlyMap<
  string,
  ReadonlySet<string>
>;

const EMPTY_MODULE_DELEGATIONS: ModuleDelegationMap = new Map();

/**
 * Runtime-minted compiler attestation. Compiled documents carry it at their
 * root; source documents carry it only on delegation metadata, whose mutable
 * value is otherwise excluded from the source Merkle identity.
 */
export const COMPILED_INTEGRITY_ATOM: string = CFC_COMPILED_BY_ATOM;

const SOURCE_DELEGATION_PATH = ["delegatedModuleIdentities"] as const;

interface ModuleDocBase {
  /** Module code: authored TS (source set) or compiled JS (compiled set). */
  readonly code: string;
  /** Authored module path, e.g. `/main.tsx`. */
  readonly filename: string;
  /** Resolved internal imports; each points at another document by identity. */
  readonly imports: readonly ModuleImportRef[];
  /** Predecessor module identities whose writer authority this module inherits. */
  readonly delegatedModuleIdentities?: readonly string[];
}

/** A source-set document (`pattern:<identity>`). */
export interface SourceDoc extends ModuleDocBase {
  readonly kind: "source";
  /**
   * Optional, NON-NORMATIVE product annotations (a name doc, a spec doc,
   * lineage — typically sigil links). The runtime NEVER reads these for
   * execution and {@link verifySourceDocs} EXCLUDES them from the content hash:
   * the document identity is a Merkle hash of `(source, import identities)`
   * only, so an annotated and an unannotated doc verify identically. Present
   * only on the entry document, written by `PatternManager.annotatePattern`.
   */
  readonly annotations?: Record<string, unknown>;
}

/** A compiled-set document (`compileCache:<runtimeVersion>/<identity>`). */
export interface CompiledDoc extends ModuleDocBase {
  readonly kind: "compiled";
  /** Per-module source map, if any (registered for fn.src / CFC resolution). */
  readonly sourceMap?: unknown;
  /**
   * Precomputed record surface (Fix B): the direct export names, `export *`
   * target specifiers, and runtime import specifiers derived from `code` at
   * compile time. Lets the boot-time record build skip the in-worker TS parse.
   * Absent on documents written before the field existed (→ parse fallback).
   */
  readonly exportNames?: readonly string[];
  readonly starTargetSpecs?: readonly string[];
  readonly importSpecs?: readonly string[];
  readonly policyManifests?: readonly unknown[];
  /**
   * Authored-line spans for the coverage probes the transformer baked into
   * `code`, keyed by `(fileName, id)`. Present only on documents written by a
   * coverage-instrumented compile, which store under their own runtime-version
   * variant (`<runtimeVersion>/pattern-coverage`), so an ordinary
   * document never carries them. A collector maps a probe's `(fileName, id)`
   * back to source lines through these spans; a warm load that registers none
   * reports nothing.
   */
  readonly patternCoverageSpans?: readonly PatternCoverageSpan[];
}

const canonicalModuleFilename = (filename: string): string =>
  normalize(filename.replaceAll("\\", "/"));

const validDelegatedModuleIdentities = (
  identity: string,
  ...values: readonly unknown[]
): string[] => {
  const merged = new Set<string>();
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const candidate of value) {
      if (
        typeof candidate === "string" && candidate.length > 0 &&
        candidate !== identity
      ) {
        merged.add(candidate);
      }
    }
  }
  return [...merged].sort();
};

/**
 * Match a previous verified source closure to a newly emitted module set by
 * canonical full filename. Matching deliberately uses the whole normalized
 * path, never a basename: `../shared/writer.ts` has already resolved to the
 * stored module filename, while two different `writer.ts` files remain
 * distinct. Ambiguous duplicate canonical names are skipped fail-closed.
 *
 * Each successor inherits both its direct predecessor and that predecessor's
 * cumulative delegation list, preserving update chains across a cold reload.
 */
export function deriveModuleDelegations(
  previous: ReadonlyMap<string, SourceDoc>,
  next: readonly CacheableModule[],
): Map<string, ReadonlySet<string>> {
  const previousByName = new Map<
    string,
    { identity: string; doc: SourceDoc }[]
  >();
  for (const [identity, doc] of previous) {
    const name = canonicalModuleFilename(doc.filename);
    const entries = previousByName.get(name) ?? [];
    entries.push({ identity, doc });
    previousByName.set(name, entries);
  }

  const nextNameCounts = new Map<string, number>();
  for (const module of next) {
    const name = canonicalModuleFilename(module.filename);
    nextNameCounts.set(name, (nextNameCounts.get(name) ?? 0) + 1);
  }

  const delegations = new Map<string, ReadonlySet<string>>();
  for (const module of next) {
    const name = canonicalModuleFilename(module.filename);
    const matches = previousByName.get(name);
    if (matches?.length !== 1 || nextNameCounts.get(name) !== 1) continue;
    const predecessor = matches[0];
    const inherited = validDelegatedModuleIdentities(
      module.identity,
      predecessor.identity === module.identity ? [] : [predecessor.identity],
      predecessor.doc.delegatedModuleIdentities,
    );
    if (inherited.length > 0) {
      delegations.set(module.identity, new Set(inherited));
    }
  }
  return delegations;
}

export function moduleDelegationsFromDocs(
  docs: ReadonlyMap<string, ModuleDocBase>,
): Map<string, ReadonlySet<string>> {
  const result = new Map<string, ReadonlySet<string>>();
  for (const [identity, doc] of docs) {
    const delegated = validDelegatedModuleIdentities(
      identity,
      doc.delegatedModuleIdentities,
    );
    if (delegated.length > 0) result.set(identity, new Set(delegated));
  }
  return result;
}

/**
 * Version tag for the compiled-set axis (`compileCache:<runtimeVersion>/...`).
 * A compiled document is only reused under a matching tag, so a change to this
 * value invalidates the whole compiled set after any change to the compiler /
 * transformer pipeline or SES verifier that alters emitted bytes (the source
 * set, keyed by content identity alone, persists across the change).
 *
 * The value is generated from a hash of the compiler inputs defined in
 * `compiler-fingerprint.deno.ts`. Editing those inputs moves the tag and
 * invalidates stale compiled docs. Deno source runs resolve the checked-in
 * source marker to that hash at runtime. Runtimes without repository file access
 * skip the compiled cache until a binary build bakes the hash into
 * `compile-cache-version.ts`. See `getCompileCacheRuntimeVersion()` and
 * `compiler-fingerprint.deno.ts`.
 */
export {
  COMPILE_CACHE_RUNTIME_VERSION,
  SOURCE_COMPILE_CACHE_RUNTIME_VERSION,
} from "./compile-cache-version.ts";

type CompilerFingerprintModule = {
  computeCurrentCompilerVersion(): Promise<string>;
};

type CompileCacheVersionGlobal = typeof globalThis & {
  __cfCompileCacheRuntimeVersion?: unknown;
};

let compileCacheRuntimeVersion: Promise<string | undefined> | undefined;
let compileCacheRuntimeVersionForTesting:
  | Promise<string | undefined>
  | undefined;

export function getCompileCacheRuntimeVersion(): Promise<string | undefined> {
  if (compileCacheRuntimeVersionForTesting !== undefined) {
    return compileCacheRuntimeVersionForTesting;
  }
  compileCacheRuntimeVersion ??= resolveCompileCacheRuntimeVersion();
  return compileCacheRuntimeVersion;
}

export function setCompileCacheRuntimeVersionForTesting(
  version: string | undefined,
): () => void {
  const previous = compileCacheRuntimeVersionForTesting;
  compileCacheRuntimeVersionForTesting = Promise.resolve(version);
  return () => {
    compileCacheRuntimeVersionForTesting = previous;
  };
}

export function resolveBakedCompileCacheRuntimeVersionForTesting(
  version: string,
): Promise<string | undefined> {
  return resolveCompileCacheRuntimeVersion(version);
}

async function resolveCompileCacheRuntimeVersion(): Promise<
  string | undefined
>;
async function resolveCompileCacheRuntimeVersion(
  version: string,
): Promise<string | undefined>;
async function resolveCompileCacheRuntimeVersion(
  version = COMPILE_CACHE_RUNTIME_VERSION,
): Promise<string | undefined> {
  const definedVersion = buildDefinedCompileCacheRuntimeVersion();
  if (definedVersion !== undefined) {
    return definedVersion;
  }
  if (version !== SOURCE_COMPILE_CACHE_RUNTIME_VERSION) {
    return version;
  }
  if (!hasDenoRuntime()) {
    return undefined;
  }
  const specifier = new URL(
    "./compiler-fingerprint.deno.ts",
    import.meta.url,
  ).href;
  try {
    const module = await import(specifier) as CompilerFingerprintModule;
    return await module.computeCurrentCompilerVersion();
  } catch (error) {
    if (isUnavailableSourceFingerprint(error)) {
      return undefined;
    }
    throw error;
  }
}

function buildDefinedCompileCacheRuntimeVersion(): string | undefined {
  const value = (globalThis as CompileCacheVersionGlobal)
    .__cfCompileCacheRuntimeVersion;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hasDenoRuntime(): boolean {
  const candidate = globalThis as { Deno?: { stat?: unknown } };
  return typeof candidate.Deno?.stat === "function";
}

function isUnavailableSourceFingerprint(error: unknown): boolean {
  return [
    "NotFound",
    "NotADirectory",
    "NotCapable",
    "PermissionDenied",
  ].some((name) => isDenoError(error, name));
}

function isDenoError(error: unknown, name: string): boolean {
  const errors = (globalThis as {
    Deno?: { errors?: Record<string, unknown> };
  }).Deno?.errors;
  const errorClass = errors?.[name];
  return typeof errorClass === "function" && error instanceof errorClass;
}

/** Cell key (id) for a source-set document. */
export function sourceDocKey(identity: string): string {
  return `pattern:${identity}`;
}

/** Cell key (id) for a compiled-set document. */
export function compiledDocKey(
  runtimeVersion: string,
  identity: string,
): string {
  return `compileCache:${runtimeVersion}/${identity}`;
}

/**
 * Synthetic import specifier prefix for a link the cache adds from the entry
 * document to a module that is part of the emitted program but not reachable
 * from the entry through the natural import graph (e.g. the injected `cfc.ts`
 * helper, pulled in via a `.d.ts` re-export with no runtime import edge).
 * Without it the link-following loader would never fetch such a module, so a
 * warm closure would always be incomplete. These links carry no authored
 * specifier, so they are ignored by the Merkle identity recompute (which
 * resolves a module's edges from its own source, not its stored links).
 */
export const ROOT_LINK_SPECIFIER = "cf:cache-root/";

/** Identities of emitted modules not reachable from the entry via imports. */
function unreachedRoots(
  modules: readonly CacheableModule[],
  entryIdentity: string,
): string[] {
  const byId = new Map(modules.map((m) => [m.identity, m]));
  const seen = new Set<string>();
  const queue: string[] = [entryIdentity];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const imp of byId.get(id)?.imports ?? []) {
      queue.push(imp.targetIdentity);
    }
  }
  return modules.filter((m) => !seen.has(m.identity)).map((m) => m.identity);
}

/**
 * Persisted cache entries must be a pure function of their module identity.
 * An UNPINNED fabric specifier breaks that: the Merkle identity folds the
 * specifier TEXT (not the resolution result), so two compiles of
 * byte-identical source can chase to different targets and produce different
 * documents under the same `pattern:`/`compileCache:` key. Unpinned
 * resolution (`FabricImportOptions.allowUnpinned`) is therefore dev-only and
 * must never reach the persistent cache — both write paths fail loudly here.
 */
function assertNoUnpinnedFabricImports(
  modules: readonly CacheableModule[],
): void {
  for (const module of modules) {
    for (const imp of module.imports) {
      if (!isFabricImportSpecifier(imp.specifier)) continue;
      const ref = parseFabricRef(imp.specifier);
      if (ref !== undefined && pinnedIdentity(ref) === undefined) {
        throw new Error(
          `refusing to cache module '${module.filename}': unpinned fabric import '${imp.specifier}' (unpinned resolution is dev-only; pin before deploy)`,
        );
      }
    }
  }
}

/**
 * The resolved internal-import edges to store on a module's document, augmented
 * (for the entry module only) with synthetic root links to any otherwise-
 * unreachable emitted module so the link-following loader fetches the whole set.
 */
function storedImportRefs(
  module: CacheableModule,
  entryIdentity: string,
  extraRoots: readonly string[],
  options: { includeFabricEdges: boolean },
): ModuleImportRef[] {
  const refs: ModuleImportRef[] = module.imports
    .filter((imp) =>
      options.includeFabricEdges || !isFabricImportSpecifier(imp.specifier)
    )
    .map((imp) => ({
      specifier: imp.specifier,
      identity: imp.targetIdentity,
    }));
  if (module.identity === entryIdentity) {
    for (const rootIdentity of extraRoots) {
      refs.push({
        specifier: `${ROOT_LINK_SPECIFIER}${rootIdentity}`,
        identity: rootIdentity,
      });
    }
  }
  return refs;
}

/**
 * Build the source-set documents for an emitted module set, keyed by module
 * identity. Each document's `imports` resolve internal edges to the imported
 * module's identity (so a reader can follow links to the dependency documents);
 * the entry document additionally links any module unreachable through the
 * natural import graph (see {@link ROOT_LINK_SPECIFIER}).
 */
export function buildSourceDocs(
  modules: readonly CacheableModule[],
  entryIdentity: string,
  moduleDelegations: ModuleDelegationMap = EMPTY_MODULE_DELEGATIONS,
): Map<string, SourceDoc> {
  const extraRoots = unreachedRoots(modules, entryIdentity);
  const out = new Map<string, SourceDoc>();
  for (const module of modules) {
    const delegatedModuleIdentities = validDelegatedModuleIdentities(
      module.identity,
      [...(moduleDelegations.get(module.identity) ?? [])],
    );
    out.set(module.identity, {
      kind: "source",
      code: module.source,
      filename: module.filename,
      imports: storedImportRefs(module, entryIdentity, extraRoots, {
        includeFabricEdges: false,
      }),
      ...(delegatedModuleIdentities.length > 0
        ? { delegatedModuleIdentities }
        : {}),
    });
  }
  return out;
}

/** Result of verifying a loaded source-document closure. */
export interface SourceDocVerification {
  readonly ok: boolean;
  /** The entry document's authored filename, when present. */
  readonly entryFilename?: string;
  /** Identities whose recomputed Merkle hash does not match their key. */
  readonly mismatches: readonly string[];
  /** Import-link target identities absent from the loaded document set. */
  readonly missing: readonly string[];
}

/**
 * Verify a loaded source-document closure by **recomputing** each module's
 * Merkle identity from the documents' authored source and import graph and
 * checking it equals the identity the document is keyed by. This is the
 * content-addressed analog of the structural graph verifier: because the
 * identity is a one-way Merkle hash over `(source, import identities)`, a
 * single document's content does not determine its key — the reachable
 * closure must recompute consistently. Tampering with any source, or rewiring
 * an import link, makes the recomputed identity diverge from the key.
 *
 * Each document is verified against **its own view**: the documents reachable
 * from it over authored-import edges (root links excluded — a
 * {@link ROOT_LINK_SPECIFIER} edge is never part of any module's Merkle
 * preimage). One closure may legally hold several generations of the same
 * ambient filename (e.g. two seals' injected `cfc.ts`, each root-linked by a
 * different entry): identities are entry-point independent, so a shared
 * dependency document keeps whichever seal's root links wrote it last, and a
 * link walk then reaches sibling generations. Hashing the whole closure as
 * one program would collide those filenames and permanently fail one
 * generation; per-view recomputation verifies each against the emission
 * that produced it. Within a single view, filenames are unique by
 * construction (one program emission cannot contain two files at one path) —
 * a view that violates this cannot be attributed to any emission, and its
 * root document is rejected.
 *
 * Extra unrelated documents in the set are harmless to their siblings: a
 * module's identity depends only on its own reachable view. Every document in
 * the set is still verified (in its own view).
 */
export function verifySourceDocs(
  entryIdentity: string,
  docsByIdentity: ReadonlyMap<string, SourceDoc>,
  runtimeFingerprint = "",
): SourceDocVerification {
  const entry = docsByIdentity.get(entryIdentity);
  if (entry === undefined) {
    return { ok: false, mismatches: [], missing: [entryIdentity] };
  }

  const missing: string[] = [];
  for (const doc of docsByIdentity.values()) {
    for (const imp of doc.imports) {
      if (!docsByIdentity.has(imp.identity)) missing.push(imp.identity);
    }
  }

  // identity → whether its recomputed hash matches its key. A verdict reached
  // inside one view holds in every view (entry-point independence), so each
  // document is hashed at most once.
  const verdicts = new Map<string, boolean>();
  for (const [rootIdentity, rootDoc] of docsByIdentity) {
    if (verdicts.has(rootIdentity)) continue;

    // The root's view: BFS over authored-import edges only.
    const viewIds: string[] = [];
    const seen = new Set<string>();
    const queue = [rootIdentity];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const doc = docsByIdentity.get(id);
      if (doc === undefined) continue; // dangling edge — recorded in `missing`
      viewIds.push(id);
      for (const imp of doc.imports) {
        if (imp.specifier.startsWith(ROOT_LINK_SPECIFIER)) continue;
        queue.push(imp.identity);
      }
    }

    const files = viewIds.map((id) => {
      const doc = docsByIdentity.get(id)!;
      return { name: doc.filename, contents: doc.code };
    });
    if (new Set(files.map((f) => f.name)).size !== files.length) {
      // Duplicate filename within one view: not attributable to any emission.
      // Only the root is condemned — an intact member still verifies in its
      // own (necessarily smaller) view when the loop reaches it.
      verdicts.set(rootIdentity, false);
      continue;
    }

    const recomputed = computeModuleHashes(
      { main: rootDoc.filename, files },
      { runtimeFingerprint },
    );
    for (const id of viewIds) {
      if (!verdicts.has(id)) {
        verdicts.set(
          id,
          recomputed.get(docsByIdentity.get(id)!.filename) === id,
        );
      }
    }
  }

  const mismatches = [...verdicts.entries()]
    .filter(([, ok]) => !ok)
    .map(([identity]) => identity);

  return {
    ok: mismatches.length === 0 && missing.length === 0,
    entryFilename: entry.filename,
    mismatches,
    missing,
  };
}

// --- Source-set store (4.3.2): write/read `pattern:<identity>` cells ---------

/**
 * Stored shape of a source-set cell. Mirrors {@link SourceDoc} but each import
 * carries a sigil **link** to the dependency's cell (so the storage layer
 * follows it and loads the closure), plus the module's own `identity` for
 * read-side keying. The stored identity is not trusted — {@link verifySourceDocs}
 * recomputes it.
 */
interface StoredSourceDoc {
  kind: "source";
  identity: string;
  code: string;
  filename: string;
  imports: { specifier: string; link: unknown }[];
  delegatedModuleIdentities?: string[];
  // Optional product annotations — see {@link SourceDoc.annotations}. Stored
  // verbatim; never part of the content identity.
  annotations?: Record<string, unknown>;
}

/**
 * Schema for a source-set document. **Recursive**: each `imports[].link` is an
 * `asCell` reference back to a source document (`$ref: "#/$defs/sourceDoc"`), so
 * syncing the entry cell under this schema transitively loads the *entire*
 * import closure in one round-trip — the storage layer follows the sigil links
 * and pulls every reachable document. No per-cell `sync()` is needed on load.
 */
export const SOURCE_DOC_SCHEMA = {
  $defs: {
    sourceDoc: {
      type: "object",
      properties: {
        kind: { type: "string" },
        identity: { type: "string" },
        code: { type: "string" },
        filename: { type: "string" },
        imports: {
          type: "array",
          items: {
            type: "object",
            properties: {
              specifier: { type: "string" },
              link: { $ref: "#/$defs/sourceDoc", asCell: ["cell"] },
            },
          },
        },
        delegatedModuleIdentities: {
          type: "array",
          items: { type: "string" },
        },
        // Optional, non-normative product annotations (see SourceDoc).
        annotations: { type: "object" },
      },
    },
  },
  $ref: "#/$defs/sourceDoc",
} as const satisfies JSONSchema;

/**
 * Flat source-document write schema. Only delegation metadata receives the
 * runtime-minted compiler attestation: source code/imports remain
 * self-verifying through their content identity, while annotations remain
 * independently mutable.
 */
function sourceDocWriteSchema(): JSONSchema {
  return {
    type: "object",
    properties: {
      kind: { type: "string" },
      identity: { type: "string" },
      code: { type: "string" },
      filename: { type: "string" },
      imports: {
        type: "array",
        items: {
          type: "object",
          properties: {
            specifier: { type: "string" },
            link: true,
          },
        },
      },
      delegatedModuleIdentities: {
        type: "array",
        items: { type: "string" },
        ifc: { addIntegrity: [COMPILED_INTEGRITY_ATOM] },
      },
      annotations: { type: "object" },
    },
  };
}

/** Attribute cache-document writes to the trusted compiler builtin. */
function withCompileCacheBuiltin<T>(
  tx: IExtendedStorageTransaction,
  action: () => T,
): T {
  const priorIdentity = tx.getCfcState().implementationIdentity;
  tx.setCfcImplementationIdentity({
    kind: "builtin",
    builtinId: "compile-cache",
  });
  try {
    return action();
  } finally {
    tx.setCfcImplementationIdentity(priorIdentity);
  }
}

/**
 * One-hop selector for pre-syncing write-back targets (CT-1848). A stored
 * source/compiled doc's `imports` array holds LIVE links to per-edge element
 * docs (the cell layer hoists each `{specifier, link}` element into its own
 * derived doc); the element doc's own `link` field is a *quoted* link — data,
 * not a traversal edge — so this schema pulls exactly the doc plus its edge
 * element docs and stops. A schema-less `sync()` normalizes to the rejecting
 * selector and delivers only the root, leaving the element docs unknown to
 * the replica — then the re-write touches them blind and the engine reveals
 * the conflicts one per commit attempt (the CT-1824 loop; the write-back's
 * retry budget converges it, one round per edge doc). With the element docs
 * client-known up front, the re-write diffs against true state and commits
 * on the first attempt. Recursion is deliberately omitted: the write-target
 * pre-sync enumerates every module doc itself, so each doc only needs its
 * own edges — nothing beyond the write set loads (the lazy-by-default
 * posture for code docs is untouched).
 */
export const WRITE_TARGET_EDGE_SYNC_SCHEMA = {
  type: "object",
  properties: {
    delegatedModuleIdentities: {
      type: "array",
      items: { type: "string" },
    },
    imports: {
      type: "array",
      items: {
        type: "object",
        properties: {
          specifier: { type: "string" },
          link: true,
        },
      },
    },
  },
} as const satisfies JSONSchema;

/**
 * Write every emitted module as a `pattern:<identity>` cell into `space`, each
 * import a sigil link to its dependency cell (the entry additionally linking any
 * otherwise-unreachable module). Idempotent (content-addressed keys). The caller
 * owns the transaction's commit. Returns the authenticated delegation union
 * actually staged by this write.
 */
export function writeSourceDocs(
  runtime: Runtime,
  space: MemorySpace,
  modules: readonly CacheableModule[],
  entryIdentity: string,
  tx: IExtendedStorageTransaction,
  moduleDelegations: ModuleDelegationMap = EMPTY_MODULE_DELEGATIONS,
): ModuleDelegationMap {
  assertNoUnpinnedFabricImports(modules);
  const effectiveModuleDelegations = effectiveModuleDelegationsForWrite(
    runtime,
    space,
    modules,
    tx,
    moduleDelegations,
    { source: true },
  );
  const docs = buildSourceDocs(
    modules,
    entryIdentity,
    effectiveModuleDelegations,
  );
  withCompileCacheBuiltin(tx, () => {
    for (const [identity, doc] of docs) {
      const baseCell = runtime.getCell<StoredSourceDoc>(
        space,
        sourceDocKey(identity),
        undefined,
        tx,
      );
      // Preserve product annotations on the entry doc only. Annotations are
      // only written there; reading every dependency doc here turns unrelated
      // stale cache cells into writeback conflict preconditions.
      const existing = baseCell.get();
      const existingAnnotations = identity === entryIdentity
        ? existing?.annotations
        : undefined;
      const delegatedModuleIdentities = [
        ...(doc.delegatedModuleIdentities ?? []),
      ];
      // A source document without delegation metadata remains an ordinary,
      // self-verifying cache write. Attaching an addIntegrity schema even when
      // the field is absent would make every legacy/direct source-cache write
      // CFC-relevant and require an otherwise-unnecessary prepare step.
      const cell = delegatedModuleIdentities.length > 0
        ? baseCell.asSchema(sourceDocWriteSchema())
        : baseCell;
      cell.set({
        kind: "source",
        identity,
        code: doc.code,
        filename: doc.filename,
        imports: doc.imports.map((imp) => ({
          specifier: imp.specifier,
          link: runtime.getCell(
            space,
            sourceDocKey(imp.identity),
            undefined,
            tx,
          ).getAsLink(),
        })),
        ...(delegatedModuleIdentities.length > 0
          ? { delegatedModuleIdentities }
          : {}),
        ...(isRecord(existingAnnotations)
          ? { annotations: existingAnnotations }
          : {}),
      } as StoredSourceDoc);
    }
  });
  return effectiveModuleDelegations;
}

/**
 * Load the source-document closure reachable from `entryIdentity` in `space` by
 * following import links. A **single** `sync()` on the entry cell under the
 * recursive {@link SOURCE_DOC_SCHEMA} transitively loads the whole closure (the
 * storage layer follows the `asCell` sigil links), so the walk below reads the
 * already-loaded linked cells synchronously — no per-cell `sync()`. Returns the
 * raw documents keyed by their **stored** identity (verify with
 * {@link verifySourceDocs} before trusting). Resolves to `undefined` if the
 * entry document is absent or any cache import link crosses out of `space`.
 */
export async function loadSourceClosure(
  runtime: Runtime,
  space: MemorySpace,
  entryIdentity: string,
  tx: IExtendedStorageTransaction,
): Promise<Map<string, SourceDoc> | undefined> {
  const entry = runtime.getCell(
    space,
    sourceDocKey(entryIdentity),
    SOURCE_DOC_SCHEMA,
    tx,
  );
  // One sync pulls the entire link closure (recursive schema). No further syncs.
  await entry.sync();
  const root = entry.get() as StoredSourceDoc | undefined;
  if (!root || typeof root.identity !== "string") return undefined;

  const out = new Map<string, SourceDoc>();
  const queue: { doc: StoredSourceDoc; cell: Cell<unknown> }[] = [{
    doc: root,
    cell: entry,
  }];
  while (queue.length > 0) {
    const { doc, cell } = queue.shift()!;
    if (out.has(doc.identity)) continue;
    const imports: ModuleImportRef[] = [];
    const childDocs: { doc: StoredSourceDoc; cell: Cell<unknown> }[] = [];
    for (const imp of doc.imports ?? []) {
      // `link` is already a loaded Cell (the entry sync pulled it). View it
      // under the recursive schema so its own links resolve as cells too.
      if (!isCell(imp.link)) continue;
      const linkedCell = imp.link as Cell<unknown>;
      // Cache attestations are space-local. A cross-space child may be validly
      // compiler-stamped in its own space, but must never be flattened into
      // the requested space's verified closure (and delegation registry).
      if (linkedCell.space !== space) return undefined;
      const childCell = linkedCell.asSchema(
        SOURCE_DOC_SCHEMA,
      );
      const child = childCell.get() as StoredSourceDoc | undefined;
      if (!child || typeof child.identity !== "string") continue;
      imports.push({ specifier: imp.specifier, identity: child.identity });
      childDocs.push({ doc: child, cell: childCell });
    }
    const delegatedModuleIdentities = cellCarriesIntegrity(
        cell,
        COMPILED_INTEGRITY_ATOM,
        tx,
        SOURCE_DELEGATION_PATH,
      )
      ? validDelegatedModuleIdentities(
        doc.identity,
        doc.delegatedModuleIdentities,
      )
      : [];
    out.set(doc.identity, {
      kind: "source",
      code: doc.code,
      filename: doc.filename,
      imports,
      ...(delegatedModuleIdentities.length > 0
        ? { delegatedModuleIdentities }
        : {}),
      ...(isRecord(doc.annotations) ? { annotations: doc.annotations } : {}),
    });
    for (const child of childDocs) {
      if (!out.has(child.doc.identity)) queue.push(child);
    }
  }
  return out;
}

/**
 * Load the source closure (see {@link loadSourceClosure}) and **graph-wiring
 * verify** it (step 4.3.6): recompute every module's Merkle identity from the
 * loaded source + import graph and require it to equal its document key. This is
 * the content-addressed analog of `verifyModuleGraph` — the source set is
 * self-verifying (content-addressing IS the integrity), so a tampered source, a
 * rewired link, or an incomplete closure is rejected here. Resolves to the
 * verified closure, or `undefined` if the entry is absent or verification fails.
 */
export async function loadVerifiedSourceClosure(
  runtime: Runtime,
  space: MemorySpace,
  entryIdentity: string,
  tx: IExtendedStorageTransaction,
  runtimeFingerprint = "",
): Promise<Map<string, SourceDoc> | undefined> {
  const closure = await loadSourceClosure(runtime, space, entryIdentity, tx);
  if (closure === undefined) return undefined;
  // Identity verification parses source (module hashing scans imports), and
  // every source-closure consumer parses further downstream (fabric-import
  // scans, recompiles) — this is the shared entry those flows funnel through,
  // so load the deferred compiler stack here, once.
  await ensureCompilerStack();
  const verification = verifySourceDocs(
    entryIdentity,
    closure,
    runtimeFingerprint,
  );
  if (!verification.ok) {
    // Name the offenders (bounded): a bare count forces whoever hits this
    // into probe archaeology to find which doc failed and why.
    const describe = (identities: readonly string[]) =>
      identities.slice(0, 4)
        .map((id) => `${id}(${closure.get(id)?.filename ?? "absent"})`)
        .join(",") + (identities.length > 4 ? ",…" : "");
    logger.warn("source-closure-verify-failed", () => [
      `entry=${entryIdentity}`,
      `mismatches=${verification.mismatches.length}` +
      (verification.mismatches.length > 0
        ? ` [${describe(verification.mismatches)}]`
        : ""),
      `missing=${verification.missing.length}` +
      (verification.missing.length > 0
        ? ` [${describe(verification.missing)}]`
        : ""),
    ]);
    return undefined;
  }
  runtime.registerModuleDelegations(
    space,
    moduleDelegationsFromDocs(closure),
  );
  return closure;
}

// --- Compiled-set store (4.3.3): `compileCache:<rtver>/<identity>` + CFC ------

const compiledDocProperties = {
  kind: { type: "string" },
  identity: { type: "string" },
  code: { type: "string" },
  filename: { type: "string" },
  sourceMap: {},
  exportNames: { type: "array", items: { type: "string" } },
  starTargetSpecs: { type: "array", items: { type: "string" } },
  importSpecs: { type: "array", items: { type: "string" } },
  patternCoverageSpansJson: { type: "string" },
  policyManifests: {
    type: "array",
    items: { type: "object", additionalProperties: true },
  },
  delegatedModuleIdentities: {
    type: "array",
    items: { type: "string" },
  },
  imports: {
    type: "array",
    items: {
      type: "object",
      properties: {
        specifier: { type: "string" },
        link: { asCell: ["cell"] },
      },
    },
  },
} as const;

/**
 * Read schema for a compiled document. **Recursive**: each `imports[].link` is
 * an `asCell` reference back to a compiled document, so a single `sync()` on the
 * entry cell transitively loads the entire compiled closure (one round-trip),
 * and the loader reads the linked cells synchronously — no per-cell `sync()`.
 */
export const COMPILED_DOC_SCHEMA = {
  $defs: {
    compiledDoc: {
      type: "object",
      properties: {
        kind: { type: "string" },
        identity: { type: "string" },
        code: { type: "string" },
        filename: { type: "string" },
        sourceMap: {},
        exportNames: { type: "array", items: { type: "string" } },
        starTargetSpecs: { type: "array", items: { type: "string" } },
        importSpecs: { type: "array", items: { type: "string" } },
        patternCoverageSpansJson: { type: "string" },
        policyManifests: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
        delegatedModuleIdentities: {
          type: "array",
          items: { type: "string" },
        },
        imports: {
          type: "array",
          items: {
            type: "object",
            properties: {
              specifier: { type: "string" },
              link: { $ref: "#/$defs/compiledDoc", asCell: ["cell"] },
            },
          },
        },
      },
    },
  },
  $ref: "#/$defs/compiledDoc",
} as const satisfies JSONSchema;

/**
 * Write schema: stamps the compiler integrity atom on the stored value. Flat
 * (no recursive `$ref`) — writing a single document does not transitively load.
 */
export function compiledDocWriteSchema(): JSONSchema {
  return {
    type: "object",
    properties: compiledDocProperties,
    ifc: { addIntegrity: [COMPILED_INTEGRITY_ATOM] },
  };
}

interface StoredCompiledDoc {
  kind: "compiled";
  identity: string;
  code: string;
  filename: string;
  sourceMap?: unknown;
  exportNames?: readonly string[];
  starTargetSpecs?: readonly string[];
  importSpecs?: readonly string[];
  patternCoverageSpansJson?: string;
  policyManifests?: readonly unknown[];
  delegatedModuleIdentities?: string[];
  imports: { specifier: string; link: unknown }[];
}

/**
 * The coverage spans stored as scalar JSON on a compiled document, parsed and
 * shape-checked. Yields `undefined` for a document written without spans, and
 * for a stored value that does not match the span shape. The load then carries
 * no spans for that module, and the collector reports no lines for it rather
 * than reporting against malformed coordinates. Spans are a reporting aid,
 * never an execution input, so a rejection here cannot affect what the module
 * does.
 */
function storedCoverageSpans(
  stored: unknown,
): readonly PatternCoverageSpan[] | undefined {
  if (typeof stored !== "string") return undefined;
  let spans: unknown;
  try {
    spans = JSON.parse(stored);
  } catch {
    return undefined;
  }
  if (!Array.isArray(spans)) return undefined;
  const out: PatternCoverageSpan[] = [];
  for (const span of spans) {
    if (!isRecord(span)) return undefined;
    const { fileName, id, kind, startLine, endLine, startColumn, endColumn } =
      span;
    if (
      typeof fileName !== "string" || typeof id !== "number" ||
      kind !== "runtime" || typeof startLine !== "number" ||
      typeof endLine !== "number" || typeof startColumn !== "number" ||
      typeof endColumn !== "number"
    ) {
      return undefined;
    }
    out.push({
      fileName,
      id,
      kind,
      startLine,
      endLine,
      startColumn,
      endColumn,
    });
  }
  return out;
}

/** Whether a cell's persisted CFC label carries `atom` at `path`. */
function cellCarriesIntegrity(
  cell: Cell<unknown>,
  atom: string,
  tx: IExtendedStorageTransaction,
  path: readonly (string | number)[] = [],
): boolean {
  const link = cell.getAsNormalizedFullLink();
  const metadata = readStoredCfcMetadata(tx, {
    space: link.space,
    id: link.id,
    scope: link.scope,
  });
  if (metadata === undefined) return false;
  return metadata.labelMap.entries.some((entry) =>
    entry.path.length === path.length &&
    entry.path.every((segment, index) => segment === path[index]) &&
    Array.isArray(entry.label.integrity) &&
    entry.label.integrity.some((a) => a === atom)
  );
}

/**
 * Compute the authority that a cache write may persist. Requested delegations
 * are unioned with only compiler-authenticated metadata already stored at the
 * selected source/compiled targets. Combined source+compiled saves use both
 * targets so the two document sets cannot diverge when shared successors are
 * updated by different patterns.
 */
function effectiveModuleDelegationsForWrite(
  runtime: Runtime,
  space: MemorySpace,
  modules: readonly CacheableModule[],
  tx: IExtendedStorageTransaction,
  requested: ModuleDelegationMap,
  targets: {
    source?: boolean;
    compiledRuntimeVersion?: string;
  },
): Map<string, ReadonlySet<string>> {
  const effective = new Map<string, ReadonlySet<string>>();
  for (const module of modules) {
    const candidates: unknown[] = [
      [...(requested.get(module.identity) ?? [])],
    ];
    if (targets.source) {
      const sourceCell = runtime.getCell<StoredSourceDoc>(
        space,
        sourceDocKey(module.identity),
        undefined,
        tx,
      );
      const existing = sourceCell.get();
      // Mutable source metadata is authority only when the compiler attested
      // this exact field; the source code/import graph verifies separately.
      if (
        cellCarriesIntegrity(
          sourceCell,
          COMPILED_INTEGRITY_ATOM,
          tx,
          SOURCE_DELEGATION_PATH,
        )
      ) {
        candidates.push(existing?.delegatedModuleIdentities);
      }
    }
    if (targets.compiledRuntimeVersion !== undefined) {
      const compiledCell = runtime.getCell<StoredCompiledDoc>(
        space,
        compiledDocKey(
          targets.compiledRuntimeVersion,
          module.identity,
        ),
        undefined,
        tx,
      );
      const existing = compiledCell.get();
      if (
        cellCarriesIntegrity(
          compiledCell,
          COMPILED_INTEGRITY_ATOM,
          tx,
        )
      ) {
        candidates.push(existing?.delegatedModuleIdentities);
      }
    }
    const delegated = validDelegatedModuleIdentities(
      module.identity,
      ...candidates,
    );
    if (delegated.length > 0) {
      effective.set(module.identity, new Set(delegated));
    }
  }
  return effective;
}

/**
 * Write every emitted module's compiled body as a
 * `compileCache:<runtimeVersion>/<identity>` cell into `space`, stamped with the
 * compiler integrity atom, imports linked to dependency compiled cells (the
 * entry additionally linking any otherwise-unreachable module). The caller must
 * `prepareCfc()` + commit the tx under an enforcing CFC mode for the integrity
 * label to persist. Returns the authenticated delegation union actually staged
 * by this write.
 */
export function writeCompiledDocs(
  runtime: Runtime,
  space: MemorySpace,
  modules: readonly CacheableModule[],
  entryIdentity: string,
  opts: {
    runtimeVersion: string;
    moduleDelegations?: ModuleDelegationMap;
  },
  tx: IExtendedStorageTransaction,
): ModuleDelegationMap {
  assertNoUnpinnedFabricImports(modules);
  const effectiveModuleDelegations = effectiveModuleDelegationsForWrite(
    runtime,
    space,
    modules,
    tx,
    opts.moduleDelegations ?? EMPTY_MODULE_DELEGATIONS,
    { compiledRuntimeVersion: opts.runtimeVersion },
  );
  const extraRoots = unreachedRoots(modules, entryIdentity);
  const schema = compiledDocWriteSchema();
  withCompileCacheBuiltin(tx, () => {
    for (const module of modules) {
      const cell = runtime.getCell(
        space,
        compiledDocKey(opts.runtimeVersion, module.identity),
        schema,
        tx,
      );
      // Fix B: derive the record surface from the compiled body once, here, so
      // the boot-time record build reads it instead of re-parsing per load.
      const derived = deriveModuleRecordFields(module.js);
      const delegatedModuleIdentities = validDelegatedModuleIdentities(
        module.identity,
        [...(effectiveModuleDelegations.get(module.identity) ?? [])],
      );
      const policyManifests = module.policyManifests?.map((input) => {
        const artifact = validateCfcPolicyArtifactManifest(input);
        if (artifact.manifest.moduleIdentity !== module.identity) {
          throw new Error(
            `policy manifest module identity mismatch for '${module.filename}'`,
          );
        }
        return artifact;
      });
      if (policyManifests !== undefined) {
        runtime.registerCfcPolicyManifests(undefined, policyManifests);
      }
      cell.set({
        kind: "compiled",
        identity: module.identity,
        code: module.js,
        filename: module.filename,
        exportNames: derived.exportNames,
        starTargetSpecs: derived.starTargetSpecs,
        importSpecs: derived.importSpecs,
        ...(module.sourceMap !== undefined
          ? { sourceMap: module.sourceMap }
          : {}),
        ...(module.patternCoverageSpans === undefined ? {} : {
          patternCoverageSpansJson: JSON.stringify(
            module.patternCoverageSpans,
          ),
        }),
        ...(policyManifests === undefined ? {} : { policyManifests }),
        ...(delegatedModuleIdentities.length > 0
          ? { delegatedModuleIdentities }
          : {}),
        imports: storedImportRefs(module, entryIdentity, extraRoots, {
          includeFabricEdges: true,
        }).map((ref) => ({
          specifier: ref.specifier,
          link: runtime.getCell(
            space,
            compiledDocKey(opts.runtimeVersion, ref.identity),
            undefined,
            tx,
          ).getAsLink(),
        })),
      } as StoredCompiledDoc);
    }
  });
  return effectiveModuleDelegations;
}

/**
 * Save matching source and compiled document sets with one authenticated
 * delegation union. This is the cache write path for compilation and repair:
 * an authority chain already present in either set is preserved in both, and
 * the returned map is the exact committed authority the caller must install in
 * its runtime after the transaction succeeds.
 */
export function writeSourceAndCompiledDocs(
  runtime: Runtime,
  space: MemorySpace,
  modules: readonly CacheableModule[],
  entryIdentity: string,
  opts: {
    runtimeVersion: string;
    moduleDelegations?: ModuleDelegationMap;
  },
  tx: IExtendedStorageTransaction,
): ModuleDelegationMap {
  assertNoUnpinnedFabricImports(modules);
  const effectiveModuleDelegations = effectiveModuleDelegationsForWrite(
    runtime,
    space,
    modules,
    tx,
    opts.moduleDelegations ?? EMPTY_MODULE_DELEGATIONS,
    {
      source: true,
      compiledRuntimeVersion: opts.runtimeVersion,
    },
  );
  writeSourceDocs(
    runtime,
    space,
    modules,
    entryIdentity,
    tx,
    effectiveModuleDelegations,
  );
  writeCompiledDocs(
    runtime,
    space,
    modules,
    entryIdentity,
    { ...opts, moduleDelegations: effectiveModuleDelegations },
    tx,
  );
  return effectiveModuleDelegations;
}

/**
 * Load the integrity-valid compiled documents reachable from `entryIdentity` by
 * following import links. A **single** `sync()` on the entry cell under the
 * recursive {@link COMPILED_DOC_SCHEMA} transitively loads the whole closure
 * (the storage layer follows the `asCell` sigil links), so the walk reads the
 * already-loaded linked cells synchronously — no per-cell `sync()`.
 *
 * Fail-closed and link-faithful: the walk follows the *actual linked cells*
 * (never re-deriving a cell from a stored `identity` field), and a cell's stored
 * doc is used only after its own persisted CFC label is confirmed to carry the
 * compiler integrity atom. So every document in the result — and every import
 * edge — came from an integrity-stamped cell in `space` that the parent's sigil
 * link actually points at; an unstamped/tampered child is dropped along with
 * the edge to it (treated as a cache miss, so the caller recompiles), while a
 * mixed-space link rejects the whole closure. The entry is the one cell looked
 * up by key, from the caller's trusted `entryIdentity`.
 *
 * Resolves to the valid documents keyed by their stored identity (empty map if
 * the entry itself is missing/unstamped).
 */
export async function loadCompiledClosure(
  runtime: Runtime,
  space: MemorySpace,
  entryIdentity: string,
  opts: { runtimeVersion: string },
  tx: IExtendedStorageTransaction,
): Promise<Map<string, CompiledDoc>> {
  const atom = COMPILED_INTEGRITY_ATOM;
  const out = new Map<string, CompiledDoc>();
  const visited = new Set<string>();

  // Integrity-gated read (fail-closed): the cell's stored doc only if its
  // persisted CFC label carries the compiler atom. No sync here — the entry's
  // single sync (below) has already transitively loaded the whole closure.
  const verifiedDoc = (
    cell: Cell<unknown>,
  ): StoredCompiledDoc | undefined => {
    if (!cellCarriesIntegrity(cell, atom, tx)) return undefined;
    const doc = cell.get() as StoredCompiledDoc | undefined;
    if (!doc || typeof doc.identity !== "string") return undefined;
    const policyManifests: unknown[] = [];
    try {
      for (const input of doc.policyManifests ?? []) {
        const snapshot = snapshotQueryResult(input);
        const artifact = validateCfcPolicyArtifactManifest(snapshot);
        if (artifact.manifest.moduleIdentity !== doc.identity) return undefined;
        policyManifests.push(artifact);
      }
    } catch {
      return undefined;
    }
    return doc.policyManifests === undefined ? doc : (() => {
      runtime.registerCfcPolicyManifests(undefined, policyManifests);
      return { ...doc, policyManifests };
    })();
  };

  const entryCell = runtime.getCell(
    space,
    compiledDocKey(opts.runtimeVersion, entryIdentity),
    COMPILED_DOC_SCHEMA,
    tx,
  );
  // One sync pulls the entire link closure (recursive schema). No further syncs.
  await entryCell.sync();
  const entryDoc = verifiedDoc(entryCell);
  if (entryDoc === undefined) return out;

  const queue: { doc: StoredCompiledDoc }[] = [{ doc: entryDoc }];
  while (queue.length > 0) {
    const { doc } = queue.shift()!;
    if (visited.has(doc.identity)) continue;
    visited.add(doc.identity);

    // Detach the spans from the transaction: the callers abort their read tx
    // before the closure is consumed, and a collector holds registered spans for
    // the life of the process.
    const coverageSpans = storedCoverageSpans(
      doc.patternCoverageSpansJson,
    );

    const imports: ModuleImportRef[] = [];
    for (const imp of doc.imports ?? []) {
      if (!isCell(imp.link)) continue;
      // `link` is an already-loaded Cell (the entry sync pulled it). View it
      // under the recursive schema so its own links resolve as cells too, then
      // integrity-check + read synchronously — no re-lookup by id, no sync.
      const linkedCell = imp.link as Cell<unknown>;
      // Compiled-cache integrity and module delegation authority are attested
      // only in the linked cell's space. Mixed-space cache graphs fail closed
      // instead of rebasing a child space's attestation onto `space`.
      if (linkedCell.space !== space) return new Map();
      const child = verifiedDoc(linkedCell.asSchema(COMPILED_DOC_SCHEMA));
      if (child === undefined) continue;
      imports.push({ specifier: imp.specifier, identity: child.identity });
      if (!visited.has(child.identity)) queue.push({ doc: child });
    }
    out.set(doc.identity, {
      kind: "compiled",
      code: doc.code,
      filename: doc.filename,
      ...(doc.sourceMap !== undefined ? { sourceMap: doc.sourceMap } : {}),
      ...(doc.exportNames !== undefined
        ? { exportNames: doc.exportNames }
        : {}),
      ...(doc.starTargetSpecs !== undefined
        ? { starTargetSpecs: doc.starTargetSpecs }
        : {}),
      ...(doc.importSpecs !== undefined
        ? { importSpecs: doc.importSpecs }
        : {}),
      ...(coverageSpans === undefined
        ? {}
        : { patternCoverageSpans: coverageSpans }),
      ...(doc.policyManifests !== undefined
        ? { policyManifests: doc.policyManifests }
        : {}),
      ...(() => {
        const delegatedModuleIdentities = validDelegatedModuleIdentities(
          doc.identity,
          doc.delegatedModuleIdentities,
        );
        return delegatedModuleIdentities.length > 0
          ? { delegatedModuleIdentities }
          : {};
      })(),
      imports,
    });
  }
  runtime.registerModuleDelegations(space, moduleDelegationsFromDocs(out));
  return out;
}
