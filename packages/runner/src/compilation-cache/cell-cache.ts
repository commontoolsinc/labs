import type { Program } from "@commonfabric/js-compiler";
import {
  computeModuleHashes,
  resolveModuleImports,
} from "../harness/module-identity.ts";

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
