import type { Program } from "@commonfabric/js-compiler";
import {
  computeModuleHashes,
  resolveModuleImports,
} from "../harness/module-identity.ts";
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
 * Per-module identities for a program: `path → identity`. Wraps
 * `computeModuleHashes` so the cache and the loader agree on identity.
 */
export function moduleIdentities(
  program: Program,
  runtimeFingerprint = "",
): Map<string, string> {
  return computeModuleHashes(program, { runtimeFingerprint });
}

/**
 * Build the source-set documents for a program, keyed by module identity. Each
 * document's `imports` resolve internal edges to the imported module's identity
 * (so a reader can follow links to the dependency documents).
 */
export function buildSourceDocs(
  program: Program,
  runtimeFingerprint = "",
): Map<string, SourceDoc> {
  const ids = moduleIdentities(program, runtimeFingerprint);
  const edges = resolveModuleImports(program);
  const out = new Map<string, SourceDoc>();
  for (const file of program.files) {
    const identity = ids.get(file.name);
    if (identity === undefined) continue;
    const imports = (edges.get(file.name)?.internalDeps ?? []).map((dep) => ({
      specifier: dep.specifier,
      identity: ids.get(dep.target)!,
    }));
    out.set(identity, {
      kind: "source",
      code: file.contents,
      filename: file.name,
      imports,
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
  const recomputed = moduleIdentities(
    { main: entry.filename, files },
    runtimeFingerprint,
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
 * Write every module of `program` as a `pattern:<identity>` cell into `space`,
 * each import a sigil link to its dependency cell. Idempotent (content-addressed
 * keys). The caller owns the transaction's commit.
 */
export function writeSourceDocs(
  runtime: Runtime,
  space: MemorySpace,
  program: Program,
  tx: IExtendedStorageTransaction,
  runtimeFingerprint = "",
): void {
  const docs = buildSourceDocs(program, runtimeFingerprint);
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
 * following import links. Returns the raw documents keyed by their **stored**
 * identity (verify with {@link verifySourceDocs} before trusting). Returns
 * `undefined` if the entry document is absent.
 */
export function loadSourceClosure(
  runtime: Runtime,
  space: MemorySpace,
  entryIdentity: string,
  tx: IExtendedStorageTransaction,
): Map<string, SourceDoc> | undefined {
  const entry = runtime.getCell(
    space,
    sourceDocKey(entryIdentity),
    SOURCE_DOC_SCHEMA,
    tx,
  );
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
 * Compiled artifacts produced by a fresh compile, keyed by authored path.
 */
export type CompiledArtifacts = Map<
  string,
  { js: string; sourceMap?: unknown }
>;

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
 * Write every module's compiled artifact as a
 * `compileCache:<runtimeVersion>/<identity>` cell into `space`, stamped with the
 * compiler integrity atom, imports linked to dependency compiled cells. The
 * caller must `prepareCfc()` + commit the tx under an enforcing CFC mode for the
 * integrity label to persist.
 */
export function writeCompiledDocs(
  runtime: Runtime,
  space: MemorySpace,
  program: Program,
  artifacts: CompiledArtifacts,
  opts: {
    runtimeVersion: string;
    compilerDid: string;
    runtimeFingerprint?: string;
  },
  tx: IExtendedStorageTransaction,
): void {
  const ids = moduleIdentities(program, opts.runtimeFingerprint);
  const edges = resolveModuleImports(program);
  const schema = compiledDocWriteSchema(opts.compilerDid);
  for (const file of program.files) {
    const identity = ids.get(file.name);
    const artifact = artifacts.get(file.name);
    if (identity === undefined || artifact === undefined) continue;
    const cell = runtime.getCell(
      space,
      compiledDocKey(opts.runtimeVersion, identity),
      schema,
      tx,
    );
    cell.set({
      kind: "compiled",
      identity,
      code: artifact.js,
      filename: file.name,
      ...(artifact.sourceMap !== undefined
        ? { sourceMap: artifact.sourceMap }
        : {}),
      imports: (edges.get(file.name)?.internalDeps ?? []).map((dep) => ({
        specifier: dep.specifier,
        link: runtime.getCell(
          space,
          compiledDocKey(opts.runtimeVersion, ids.get(dep.target)!),
          undefined,
          tx,
        ).getAsLink(),
      })),
    } as StoredCompiledDoc);
  }
}

/**
 * Load the integrity-valid compiled documents reachable from `entryIdentity` by
 * following import links. Fail-closed: a document whose persisted CFC label does
 * not carry the compiler integrity atom is dropped (treated as a cache miss for
 * that module, so the caller recompiles it). Returns the valid documents keyed
 * by their stored identity (empty map if the entry itself is missing/unstamped).
 */
export function loadCompiledClosure(
  runtime: Runtime,
  space: MemorySpace,
  entryIdentity: string,
  opts: { runtimeVersion: string; compilerDid: string },
  tx: IExtendedStorageTransaction,
): Map<string, CompiledDoc> {
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
    // Fail-closed: only integrity-stamped documents are trusted.
    if (!cellCarriesIntegrity(cell, atom, tx)) continue;
    const doc = cell.get() as StoredCompiledDoc | undefined;
    if (!doc || typeof doc.identity !== "string") continue;

    const imports: ModuleImportRef[] = [];
    for (const imp of doc.imports ?? []) {
      if (!isCell(imp.link)) continue;
      const child = (imp.link as Cell<unknown>)
        .asSchema(COMPILED_DOC_SCHEMA)
        .get() as StoredCompiledDoc | undefined;
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
