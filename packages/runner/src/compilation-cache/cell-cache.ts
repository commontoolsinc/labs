import { computeModuleHashes } from "../harness/module-identity.ts";
import type { CacheableModule } from "../harness/types.ts";
import type { MemorySpace, Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { type Cell, isCell } from "../cell.ts";
import type { JSONSchema } from "../builder/types.ts";
import { readStoredCfcMetadata } from "../cfc/metadata.ts";

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

interface ModuleDocBase {
  /** Module code: authored TS (source set) or compiled JS (compiled set). */
  readonly code: string;
  /** Authored module path, e.g. `/main.tsx`. */
  readonly filename: string;
  /** Resolved internal imports; each points at another document by identity. */
  readonly imports: readonly ModuleImportRef[];
}

/** A source-set document (`pattern:<identity>`). */
export interface SourceDoc extends ModuleDocBase {
  readonly kind: "source";
}

/** A compiled-set document (`compileCache:<runtimeVersion>/<identity>`). */
export interface CompiledDoc extends ModuleDocBase {
  readonly kind: "compiled";
  /** Per-module source map, if any (registered for fn.src / CFC resolution). */
  readonly sourceMap?: unknown;
}

/**
 * Version tag for the compiled-set axis (`compileCache:<runtimeVersion>/...`).
 * A compiled document is only reused under a matching tag, so bumping this
 * invalidates the whole compiled set after any change to the compiler /
 * transformer pipeline or SES verifier that alters emitted bytes (the source
 * set, keyed by content identity alone, persists across the bump). There is no
 * automatic build fingerprint at runtime, so this is bumped by hand.
 */
export const COMPILE_CACHE_RUNTIME_VERSION = "cf/esm-compile/v1";

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
 * The resolved internal-import edges to store on a module's document, augmented
 * (for the entry module only) with synthetic root links to any otherwise-
 * unreachable emitted module so the link-following loader fetches the whole set.
 */
function storedImportRefs(
  module: CacheableModule,
  entryIdentity: string,
  extraRoots: readonly string[],
): ModuleImportRef[] {
  const refs: ModuleImportRef[] = module.imports.map((imp) => ({
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
): Map<string, SourceDoc> {
  const extraRoots = unreachedRoots(modules, entryIdentity);
  const out = new Map<string, SourceDoc>();
  for (const module of modules) {
    out.set(module.identity, {
      kind: "source",
      code: module.source,
      filename: module.filename,
      imports: storedImportRefs(module, entryIdentity, extraRoots),
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
 * single document's content does not determine its key — the whole closure
 * must recompute consistently. Tampering with any source, or rewiring an
 * import link, makes the recomputed identity diverge from the key.
 *
 * Extra unrelated documents in the set are harmless: a module's identity
 * depends only on its own reachable closure, so siblings do not perturb it.
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

  const files = [...docsByIdentity.values()].map((doc) => ({
    name: doc.filename,
    contents: doc.code,
  }));
  const recomputed = computeModuleHashes(
    { main: entry.filename, files },
    { runtimeFingerprint },
  );

  const mismatches: string[] = [];
  const missing: string[] = [];
  for (const [identity, doc] of docsByIdentity) {
    if (recomputed.get(doc.filename) !== identity) {
      mismatches.push(identity);
    }
    for (const imp of doc.imports) {
      if (!docsByIdentity.has(imp.identity)) missing.push(imp.identity);
    }
  }

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
}

/** Schema for a source-set document; `imports[].link` auto-loads as a cell. */
export const SOURCE_DOC_SCHEMA = {
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
          link: { asCell: ["cell"] },
        },
      },
    },
  },
} as const satisfies JSONSchema;

/**
 * Write every emitted module as a `pattern:<identity>` cell into `space`, each
 * import a sigil link to its dependency cell (the entry additionally linking any
 * otherwise-unreachable module). Idempotent (content-addressed keys). The caller
 * owns the transaction's commit.
 */
export function writeSourceDocs(
  runtime: Runtime,
  space: MemorySpace,
  modules: readonly CacheableModule[],
  entryIdentity: string,
  tx: IExtendedStorageTransaction,
): void {
  const docs = buildSourceDocs(modules, entryIdentity);
  for (const [identity, doc] of docs) {
    const cell = runtime.getCell(
      space,
      sourceDocKey(identity),
      SOURCE_DOC_SCHEMA,
      tx,
    );
    cell.set({
      kind: "source",
      identity,
      code: doc.code,
      filename: doc.filename,
      imports: doc.imports.map((imp) => ({
        specifier: imp.specifier,
        link: runtime.getCell(space, sourceDocKey(imp.identity), undefined, tx)
          .getAsLink(),
      })),
    } as StoredSourceDoc);
  }
}

/**
 * Load the source-document closure reachable from `entryIdentity` in `space` by
 * following import links. Each cell is `sync()`d before reading so a closure
 * persisted in a prior session loads from storage. Returns the raw documents
 * keyed by their **stored** identity (verify with {@link verifySourceDocs}
 * before trusting). Resolves to `undefined` if the entry document is absent.
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
  await entry.sync();
  const root = entry.get() as StoredSourceDoc | undefined;
  if (!root || typeof root.identity !== "string") return undefined;

  const out = new Map<string, SourceDoc>();
  const queue: { doc: StoredSourceDoc }[] = [{ doc: root }];
  while (queue.length > 0) {
    const { doc } = queue.shift()!;
    if (out.has(doc.identity)) continue;
    const imports: ModuleImportRef[] = [];
    const childDocs: StoredSourceDoc[] = [];
    for (const imp of doc.imports ?? []) {
      if (!isCell(imp.link)) continue;
      const childCell = (imp.link as Cell<unknown>).asSchema(SOURCE_DOC_SCHEMA);
      // A linked cell is not synced transitively by the parent — sync each.
      await childCell.sync();
      const child = childCell.get() as StoredSourceDoc | undefined;
      if (!child || typeof child.identity !== "string") continue;
      imports.push({ specifier: imp.specifier, identity: child.identity });
      childDocs.push(child);
    }
    out.set(doc.identity, {
      kind: "source",
      code: doc.code,
      filename: doc.filename,
      imports,
    });
    for (const child of childDocs) {
      if (!out.has(child.identity)) queue.push({ doc: child });
    }
  }
  return out;
}

// --- Compiled-set store (4.3.3): `compileCache:<rtver>/<identity>` + CFC ------

/**
 * The CFC integrity atom stamped on a compiled document. A plain literal string
 * bound to the compiler's principal DID: structured `represents-principal`
 * atoms are runtime-resolved and rejected/owner-coupled, so the DID is baked
 * into the string instead. In the interim the label is client-asserted (a
 * same-space writer could stamp it); the hard guarantee lands when the server
 * becomes the sole acceptor of this write integrity. See the threat model in
 * docs/specs/module-loading.md.
 */
export function compiledIntegrityAtom(compilerDid: string): string {
  return `cf-compiled-by:${compilerDid}`;
}

const compiledDocProperties = {
  kind: { type: "string" },
  identity: { type: "string" },
  code: { type: "string" },
  filename: { type: "string" },
  sourceMap: {},
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

/** Read schema for a compiled document (`imports[].link` auto-loads). */
export const COMPILED_DOC_SCHEMA = {
  type: "object",
  properties: compiledDocProperties,
} as const satisfies JSONSchema;

/** Write schema: stamps the compiler integrity atom on the stored value. */
export function compiledDocWriteSchema(compilerDid: string): JSONSchema {
  return {
    type: "object",
    properties: compiledDocProperties,
    ifc: { addIntegrity: [compiledIntegrityAtom(compilerDid)] },
  };
}

interface StoredCompiledDoc {
  kind: "compiled";
  identity: string;
  code: string;
  filename: string;
  sourceMap?: unknown;
  imports: { specifier: string; link: unknown }[];
}

/** Whether a cell's persisted CFC label carries `atom` at its root path. */
function cellCarriesIntegrity(
  cell: Cell<unknown>,
  atom: string,
  tx: IExtendedStorageTransaction,
): boolean {
  const link = cell.getAsNormalizedFullLink();
  const metadata = readStoredCfcMetadata(tx, {
    space: link.space,
    id: link.id,
    scope: link.scope,
  });
  if (metadata === undefined) return false;
  return metadata.labelMap.entries.some((entry) =>
    entry.path.length === 0 &&
    Array.isArray(entry.label.integrity) &&
    entry.label.integrity.some((a) => a === atom)
  );
}

/**
 * Write every emitted module's compiled body as a
 * `compileCache:<runtimeVersion>/<identity>` cell into `space`, stamped with the
 * compiler integrity atom, imports linked to dependency compiled cells (the
 * entry additionally linking any otherwise-unreachable module). The caller must
 * `prepareCfc()` + commit the tx under an enforcing CFC mode for the integrity
 * label to persist.
 */
export function writeCompiledDocs(
  runtime: Runtime,
  space: MemorySpace,
  modules: readonly CacheableModule[],
  entryIdentity: string,
  opts: { runtimeVersion: string; compilerDid: string },
  tx: IExtendedStorageTransaction,
): void {
  const extraRoots = unreachedRoots(modules, entryIdentity);
  const schema = compiledDocWriteSchema(opts.compilerDid);
  for (const module of modules) {
    const cell = runtime.getCell(
      space,
      compiledDocKey(opts.runtimeVersion, module.identity),
      schema,
      tx,
    );
    cell.set({
      kind: "compiled",
      identity: module.identity,
      code: module.js,
      filename: module.filename,
      ...(module.sourceMap !== undefined
        ? { sourceMap: module.sourceMap }
        : {}),
      imports: storedImportRefs(module, entryIdentity, extraRoots).map(
        (ref) => ({
          specifier: ref.specifier,
          link: runtime.getCell(
            space,
            compiledDocKey(opts.runtimeVersion, ref.identity),
            undefined,
            tx,
          ).getAsLink(),
        }),
      ),
    } as StoredCompiledDoc);
  }
}

/**
 * Load the integrity-valid compiled documents reachable from `entryIdentity` by
 * following import links. Each cell is `sync()`d before reading so a closure
 * persisted in a prior session loads from storage. Fail-closed: a document whose
 * persisted CFC label does not carry the compiler integrity atom is dropped
 * (treated as a cache miss for that module, so the caller recompiles it).
 * Resolves to the valid documents keyed by their stored identity (empty map if
 * the entry itself is missing/unstamped).
 */
export async function loadCompiledClosure(
  runtime: Runtime,
  space: MemorySpace,
  entryIdentity: string,
  opts: { runtimeVersion: string; compilerDid: string },
  tx: IExtendedStorageTransaction,
): Promise<Map<string, CompiledDoc>> {
  const atom = compiledIntegrityAtom(opts.compilerDid);
  const out = new Map<string, CompiledDoc>();
  const visited = new Set<string>();
  const queue: string[] = [entryIdentity];
  while (queue.length > 0) {
    const identity = queue.shift()!;
    if (visited.has(identity)) continue;
    visited.add(identity);

    const cell = runtime.getCell(
      space,
      compiledDocKey(opts.runtimeVersion, identity),
      COMPILED_DOC_SCHEMA,
      tx,
    );
    await cell.sync();
    // Fail-closed: only integrity-stamped documents are trusted.
    if (!cellCarriesIntegrity(cell, atom, tx)) continue;
    const doc = cell.get() as StoredCompiledDoc | undefined;
    if (!doc || typeof doc.identity !== "string") continue;

    const imports: ModuleImportRef[] = [];
    for (const imp of doc.imports ?? []) {
      if (!isCell(imp.link)) continue;
      const childCell = (imp.link as Cell<unknown>).asSchema(
        COMPILED_DOC_SCHEMA,
      );
      await childCell.sync();
      const child = childCell.get() as StoredCompiledDoc | undefined;
      if (!child || typeof child.identity !== "string") continue;
      imports.push({ specifier: imp.specifier, identity: child.identity });
      if (!visited.has(child.identity)) queue.push(child.identity);
    }
    out.set(doc.identity, {
      kind: "compiled",
      code: doc.code,
      filename: doc.filename,
      ...(doc.sourceMap !== undefined ? { sourceMap: doc.sourceMap } : {}),
      imports,
    });
  }
  return out;
}
