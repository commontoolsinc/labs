import ts from "typescript";
import { getLogger } from "@commonfabric/utils/logger";
import type { Source, SourceMap } from "@commonfabric/js-compiler";
import { resolveImportSpecifier } from "@commonfabric/js-compiler";
import {
  computeModuleHashes,
  findInternalTarget,
} from "../harness/module-identity.ts";
import type { VirtualModuleRecord } from "./esm-module-loader.ts";

/**
 * Adapter from authored TypeScript sources to SES virtual module records
 * (Phase 2 of docs/specs/module-loading.md).
 *
 * Each module is compiled independently to CommonJS, content-addressed by its
 * module hash (`cf:module/<hash>`), and wrapped in a {@link VirtualModuleRecord}
 * whose `execute` evaluates the compiled body inside the SES compartment with a
 * `require` shim that delegates to `compartment.importNow`.
 *
 * Scope: this adapter handles the common module shapes — named `export`s,
 * `export default`, `export * from` (statically expanded, transitively), inline
 * type-only imports, relative imports, and bare runtime-module imports. The
 * Engine drives it with CF-transformer-pipeline output via `precompiledBodies`;
 * the bare `ts.transpileModule` fallback is for the standalone/test path.
 */

const TARGET = ts.ScriptTarget.ES2023;

const logger = getLogger("module-record-compiler");

/**
 * Memo of the two pure derivations {@link buildRecordsFromCompiled} extracts
 * from a module's compiled body: its direct export surface (names + `export *`
 * target specifiers) and its runtime `require()` specifiers. **Keyed by the
 * compiled body itself** — both derivations are pure functions of that body.
 *
 * At piece boot every system pattern loaded by identity rebuilds its record
 * graph from the SAME shared module closure, so `buildRecordsFromCompiled` runs
 * once per pattern over an identical module set and re-`createSourceFile`s every
 * body N times — the dominant cost of the warm boot path. This collapses that to
 * one parse per distinct body per worker.
 *
 * Keying on the body (not the module's source `identity`) is deliberate: a
 * content-hash identity is a hash of the *authored source*, and the same
 * identity can map to *different* compiled bytes across compilation modes /
 * runtime versions (cf. the `recordCache` note in `compileSourcesToRecords`,
 * where a precompiled body and a bare-transpiled body share a content-hash key).
 * An identity key could therefore serve one body's parse for another; the body
 * fully determines the parse, so a body key is exact and cross-contamination is
 * impossible. Cached arrays are treated as immutable; callers copy before
 * mutating or handing them to a consumer that might.
 */
const exportParseCache = new Map<
  string,
  { exportNames: readonly string[]; starTargetSpecs: readonly string[] }
>();
const importParseCache = new Map<string, readonly string[]>();

function parseCompiledExports(
  code: string,
): { exportNames: readonly string[]; starTargetSpecs: readonly string[] } {
  let hit = exportParseCache.get(code);
  if (hit === undefined) {
    const { names, starTargetSpecs } = extractCompiledExports(code);
    hit = { exportNames: [...names], starTargetSpecs };
    exportParseCache.set(code, hit);
  }
  return hit;
}

function parseCompiledImports(code: string): readonly string[] {
  let hit = importParseCache.get(code);
  if (hit === undefined) {
    hit = extractRuntimeImports(code);
    importParseCache.set(code, hit);
  }
  return hit;
}

/**
 * Create a write-once exports target for a module body. Re-assigning,
 * redefining, or deleting a property that already holds a real (non-`undefined`)
 * value throws. A `void 0` placeholder — the TS `exports.x = void 0;` forward
 * declaration — leaves the property unlocked so the subsequent real assignment
 * is permitted, and the real assignment then locks it. This blocks export
 * corruption smuggled into the evaluation of an otherwise-accepted expression,
 * which the (deliberately AST-free) verifier cannot detect.
 */
/**
 * Run a compiled module factory against a write-once exports object and snapshot
 * the declared exports onto `moduleExports` (the SES namespace target).
 *
 * Hardening:
 * - The body writes into a WRITE-ONCE exports object (see
 *   {@link createWriteOnceExports}), so a write smuggled into the evaluation of
 *   an otherwise-accepted expression (e.g. `__cf_data((exports.x = evil, 1))`)
 *   cannot overwrite an already-assigned export before the snapshot.
 * - The `module` wrapper is frozen, so the wholesale twin
 *   `__cf_data((module.exports = evil, 1))` throws in strict mode rather than
 *   swapping out the write-once object behind our back.
 * - We snapshot from the write-once object directly (never `module.exports`), so
 *   the namespace can only reflect values that passed through write-once.
 *
 * Each exported value is `harden()`ed (transitive freeze) so a consumer cannot
 * mutate the internals of an exported object/array/pattern graph either. This is
 * only possible because the metadata the engine associates after load —
 * `program` (rehydration source) and the CFC verified-load id — now lives in
 * WeakMaps (see builder/pattern-metadata.ts) rather than as properties written
 * onto the exported object, so hardening no longer blocks those associations.
 */
export function populateModuleExports(
  moduleExports: Record<string, unknown>,
  exportNames: string[],
  factory: (
    exports: Record<string, unknown>,
    require: (specifier: string) => Record<string, unknown>,
    module: { exports: Record<string, unknown> },
    register: (entries: Record<string, unknown>) => void,
  ) => void,
  requireShim: (specifier: string) => Record<string, unknown>,
  // `__cfReg`: the transformer emits a single trailing `__cfReg({ symbol: value })`
  // call to register a module's hoisted builder artifacts. It is passed as the
  // factory's 4th parameter (shadowing the no-op compartment global) so it is
  // bound to THIS module's evaluation. Defaults to a no-op for callers that do
  // not register (e.g. tests, runtime modules).
  register: (entries: Record<string, unknown>) => void = () => {},
): void {
  const writeOnceExports = createWriteOnceExports();
  const moduleObject = Object.freeze({ exports: writeOnceExports });
  factory(writeOnceExports, requireShim, moduleObject, register);
  for (const name of exportNames) {
    moduleExports[name] = hardenExportedValue(writeOnceExports[name]);
  }
  moduleExports.__esModule = true;
}

/**
 * Hoist registrations collected while evaluating a module graph: module content
 * identity (the prefix-free `cf:module/<hash>`) → (symbol → live value). Only
 * modules whose factory completed normally are present (see
 * {@link createHoistRegistrar}). The engine reads this after `importNow` and the
 * PatternManager turns each trusted entry into a `{ identity, symbol }` ref.
 */
export type HoistRegistrationSink = Map<string, Map<string, unknown>>;

/**
 * Build the per-module `__cfReg` registrar (the module factory's 4th parameter)
 * plus a `commit` hook. The registrar enforces the integrity invariants that let
 * the verifier stay simple:
 *
 * - **Run-once**: a second `__cfReg(...)` call throws — an injected/duplicate
 *   registration aborts the import (which is terminal for the module).
 * - **Closed window**: calls after the module body returns throw, so a closure
 *   that captured `__cfReg` cannot register late (e.g. from a handler callback).
 * - **Transactional**: entries are staged locally and only flushed into `sink`
 *   by `commit()`, which the caller invokes ONLY after the factory returns
 *   normally. A throw (including the run-once trap) therefore leaves nothing
 *   behind.
 *
 * Security (trust of the registered values) is enforced separately, per value,
 * by the PatternManager — not here.
 */
/**
 * The registrar handed to a module the verifier did NOT approve for hoist
 * registration (no valid top-level `__cfReg({ … })` call). Any invocation throws
 * — so a `__cfReg` reference the verifier's static check failed to reject still
 * fails closed at runtime (terminating the import) instead of registering
 * attacker-chosen values. `commit` is a no-op (nothing was staged).
 */
export function createRejectingRegistrar(): {
  register: (entries: Record<string, unknown>) => void;
  commit: () => void;
} {
  return {
    register: () => {
      throw new Error(
        "__cfReg called by a module with no verifier-approved registration",
      );
    },
    commit: () => {},
  };
}

export function createHoistRegistrar(
  identity: string,
  sink: HoistRegistrationSink,
): {
  register: (entries: Record<string, unknown>) => void;
  commit: () => void;
} {
  const staged = new Map<string, unknown>();
  let called = false;
  let open = true;
  const register = (entries: Record<string, unknown>) => {
    if (!open) {
      throw new Error("__cfReg called after module evaluation completed");
    }
    if (called) {
      throw new Error("__cfReg may be called at most once per module");
    }
    called = true;
    if (entries === null || typeof entries !== "object") {
      throw new Error("__cfReg expects an object of { symbol: value }");
    }
    for (const key of Object.keys(entries)) {
      staged.set(key, (entries as Record<string, unknown>)[key]);
    }
  };
  const commit = () => {
    open = false;
    if (staged.size > 0) sink.set(identity, staged);
  };
  return { register, commit };
}

/**
 * Transitively freeze an exported value. Uses SES `harden` (available after
 * lockdown, which the ESM loader ensures) — it no-ops on already-frozen shared
 * intrinsics, so it freezes only the value's own reachable graph. If `harden`
 * is somehow unavailable, the value is returned unfrozen rather than failing the
 * load (the namespace binding is still SES-immutable, and verified plain data is
 * already frozen by `__cf_data`).
 */
function hardenExportedValue<T>(value: T): T {
  const hardenFn = (globalThis as { harden?: <V>(v: V) => V }).harden;
  if (typeof hardenFn !== "function") {
    // On the real ESM-loader path the engine calls ensureSESLockdown() before
    // any module evaluates, so `harden` is always present. Reaching here means
    // lockdown did not run (a regression, or a direct call outside the engine
    // path): warn rather than silently shipping unfrozen exports.
    logger.warn("harden() unavailable; exported value not frozen");
    return value;
  }
  // Fail CLOSED: if hardening throws (e.g. an exotic reachable value harden
  // refuses), we cannot guarantee the export is immutable, so reject the module
  // rather than silently shipping a mutable (corruptible) export. A throw here
  // is terminal for the module — SES caches it and re-throws on every
  // subsequent importNow, matching a failed factory.
  try {
    return hardenFn(value);
  } catch (error) {
    throw new Error(
      `Failed to harden exported module value: ${String(error)}`,
      { cause: error },
    );
  }
}

export function createWriteOnceExports(): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  const locked = new Set<string | symbol>();
  const denyRelock = (key: string | symbol): never => {
    throw new TypeError(
      `Module export '${String(key)}' is write-once and was already assigned`,
    );
  };
  return new Proxy(target, {
    set(t, key, value) {
      if (locked.has(key)) denyRelock(key);
      (t as Record<string | symbol, unknown>)[key] = value;
      if (value !== undefined) locked.add(key);
      return true;
    },
    defineProperty(t, key, descriptor) {
      if (locked.has(key)) denyRelock(key);
      Reflect.defineProperty(t, key, descriptor);
      const isUndefinedPlaceholder = "value" in descriptor &&
        descriptor.value === undefined;
      if (!isUndefinedPlaceholder) locked.add(key);
      return true;
    },
    deleteProperty(_t, key) {
      throw new TypeError(
        `Module export '${String(key)}' cannot be deleted (write-once)`,
      );
    },
  });
}

/** Per-module compiled artifact, cacheable by module hash (Phase 4). */
export interface CompiledModuleArtifact {
  exports: string[];
  compiled: string;
}

/**
 * Cache of compiled module artifacts keyed by content-addressed module hash.
 * Because the hash already folds in the transitive import closure, a cached
 * artifact is valid as long as its key matches — editing one file invalidates
 * only that module (and its importers, whose hashes change).
 *
 * The cache assumes the fixed compiler options used by this adapter (CommonJS,
 * ES2023, esModuleInterop). A caller sharing one cache across differing
 * compiler options would need to fold an options tag into the key.
 */
export interface ModuleRecordCache {
  get(moduleHash: string): CompiledModuleArtifact | undefined;
  set(moduleHash: string, artifact: CompiledModuleArtifact): void;
}

export interface CompileSourcesOptions {
  /**
   * Names exported by each bare runtime module specifier (e.g.
   * `{ commonfabric: ["h", "lift"] }`). Runtime modules resolve to
   * `cf:runtime/<specifier>`; the caller must register a matching record.
   */
  runtimeModules?: Record<string, string[]>;
  runtimeFingerprint?: string;
  /** Optional per-module compiled-artifact cache, keyed by module hash. */
  recordCache?: ModuleRecordCache;
  /**
   * Pre-compiled CommonJS body per source name. When provided (e.g. from
   * `TypeScriptCompiler.compileToModules`, which runs the full CF transformer
   * pipeline), the adapter uses it instead of the bare `ts.transpileModule`
   * fallback. Required for real patterns, whose transformer output (schema
   * generation, `__cf_data` wrapping) cannot be produced by transpileModule.
   */
  precompiledBodies?: Map<string, string>;
  /**
   * Per-source source map (from `compileToModules`), keyed by source name. Used
   * to compose a per-load bundle source map so `fn.src` / CFC verified-source
   * coordinates resolve back to the original authored files under the ESM
   * loader (the AMD path registers the bundle map via the isolate).
   */
  precompiledSourceMaps?: Map<string, SourceMap>;
  /**
   * Whole-program path prefix (`/<id>`, no trailing slash) to strip from each
   * module's path *for content-addressed identity only*. The ESM compile path
   * resolves a program whose files are prefixed with `/<computeId>/...` (a
   * whole-program hash) so source locations match the AMD bundle. Folding that
   * prefix into the per-module identity would make `cf:module/<hash>`
   * whole-program-dependent — defeating cross-program dedup and diverging from
   * the entry-point-independent identity the spec mandates
   * (docs/specs/module-loading.md). Stripping it here yields stable, dedupable
   * identities while every other artifact (record sourceUrls, source-map keys,
   * `fn.src` resolution) keeps the prefixed path untouched.
   */
  idPrefix?: string;
  /**
   * Precomputed per-path module identities (from {@link computeModuleIdentities}).
   * When the caller already derived these (e.g. the Engine, for its cache-hit
   * check), passing them here avoids recomputing the hashes a second time. Must
   * be consistent with `idPrefix` / `runtimeFingerprint`.
   */
  identityByPath?: Map<string, string>;
  /**
   * Maps an authored import specifier to a concrete file already present in the
   * program. Used for scheme-prefixed fabric refs mounted under reserved paths.
   */
  specifierAliases?: ReadonlyMap<string, string>;
}

export interface CompiledModuleGraph {
  records: Map<string, VirtualModuleRecord>;
  /** Content-addressed specifier for each original file path. */
  specifierByPath: Map<string, string>;
  /** Compiled CommonJS body per specifier — the text the verifier classifies. */
  compiledBodies: Map<string, string>;
  /** Per-specifier source map (compiled body → original source), when available. */
  moduleSourceMaps: Map<string, SourceMap>;
  /**
   * Hoist registrations, populated as the graph's modules evaluate (`__cfReg`).
   * Empty until `importNow` runs each module's `execute`. The engine reads it
   * after evaluation; the PatternManager assigns `{ identity, symbol }` refs.
   */
  registrationSink: HoistRegistrationSink;
  /**
   * Specifiers of modules the VERIFIER approved for hoist registration (a valid
   * top-level `__cfReg({ … })` call). The engine fills this during the verify
   * pass (before evaluation); a module absent from it gets a throwing registrar
   * (see `createRejectingRegistrar`), so a `__cfReg` call the static verifier
   * missed fails closed at runtime instead of registering attacker values.
   */
  registrationApproved: Set<string>;
}

/**
 * Strip the whole-program `/<idPrefix>` segment from a resolved module path, so
 * its content-addressed identity is entry-point independent. Unprefixed modules
 * (e.g. the injected `cfc.ts` helper) are returned unchanged.
 */
function stripIdentityPrefix(name: string, idPrefix?: string): string {
  return idPrefix && name.startsWith(`${idPrefix}/`)
    ? name.slice(idPrefix.length)
    : name;
}

/**
 * Per-module content-addressed identity (`cf:module/<hash>` minus the `cf:module/`
 * scheme) for every source path, computed prefix-free so identities dedupe
 * across programs. Shared by {@link compileSourcesToRecords} and the Engine's
 * cache-hit check so both agree on the identity of each module. Keyed by the
 * resolved (prefixed) path; the value is the prefix-free hash.
 */
export function computeModuleIdentities(
  sources: Source[],
  options: { idPrefix?: string; runtimeFingerprint?: string } = {},
): Map<string, string> {
  const hashes = computeModuleHashes(
    {
      main: "",
      files: sources.map((s) => ({
        ...s,
        name: stripIdentityPrefix(s.name, options.idPrefix),
      })),
    },
    options.runtimeFingerprint !== undefined
      ? { runtimeFingerprint: options.runtimeFingerprint }
      : {},
  );
  const identityByPath = new Map<string, string>();
  for (const source of sources) {
    identityByPath.set(
      source.name,
      hashes.get(stripIdentityPrefix(source.name, options.idPrefix))!,
    );
  }
  return identityByPath;
}

export const FABRIC_MOUNT_ROOT = "/~cf/";

export interface FabricMount {
  /** Terminal identity the subtree was fetched by and must hash back to. */
  entryIdentity: string;
  /** Mounted path of the subtree's entry file. */
  entryPath: string;
  /** The fabric specifiers that resolve to this mount. */
  specifiers: string[];
}

/**
 * Compute module identities for a program that may include mounted fabric
 * subtrees. Authored files keep the existing idPrefix behavior; each mount is
 * hashed as its own standalone source set by stripping `/~cf/<identity>`.
 */
export function computeFabricModuleIdentities(
  sources: Source[],
  mounts: readonly FabricMount[],
  options: { idPrefix?: string; runtimeFingerprint?: string } = {},
): Map<string, string> {
  const authored: Source[] = [];
  const mountFiles = new Map<FabricMount, Source[]>();
  for (const mount of mounts) mountFiles.set(mount, []);

  for (const source of sources) {
    if (!source.name.startsWith(FABRIC_MOUNT_ROOT)) {
      authored.push(source);
      continue;
    }

    const mount = mounts.find((candidate) =>
      source.name.startsWith(mountPrefix(candidate))
    );
    if (mount === undefined) {
      throw new Error(
        `corrupt fabric mount assembly: '${source.name}' is under ${FABRIC_MOUNT_ROOT} but matches no mount`,
      );
    }
    mountFiles.get(mount)!.push(source);
  }

  const result = computeModuleIdentities(authored, options);
  for (const mount of mounts) {
    const identities = computeModuleIdentities(mountFiles.get(mount) ?? [], {
      idPrefix: `${FABRIC_MOUNT_ROOT}${mount.entryIdentity}`,
      ...(options.runtimeFingerprint !== undefined
        ? { runtimeFingerprint: options.runtimeFingerprint }
        : {}),
    });
    const actual = identities.get(mount.entryPath);
    if (actual !== mount.entryIdentity) {
      throw new Error(
        `integrity failure for fabric mount ${mount.entryIdentity}: mounted entry '${mount.entryPath}' hashed to '${actual}'`,
      );
    }
    for (const [path, identity] of identities) {
      result.set(path, identity);
    }
  }
  return result;
}

function mountPrefix(mount: FabricMount): string {
  return `${FABRIC_MOUNT_ROOT}${mount.entryIdentity}/`;
}

export function compileSourcesToRecords(
  sources: Source[],
  options: CompileSourcesOptions = {},
): CompiledModuleGraph {
  const runtimeModules = options.runtimeModules ?? {};
  // Identities are computed prefix-free (see computeModuleIdentities) so
  // `cf:module/<hash>` is entry-point independent and dedupes across programs.
  // Reuse the caller's precomputed map when supplied (avoids a second hash pass).
  const identityByPath = options.identityByPath ??
    computeModuleIdentities(sources, {
      ...(options.idPrefix !== undefined ? { idPrefix: options.idPrefix } : {}),
      ...(options.runtimeFingerprint !== undefined
        ? { runtimeFingerprint: options.runtimeFingerprint }
        : {}),
    });
  const fileNames = new Set(sources.map((s) => s.name));
  const specifierByPath = new Map<string, string>();
  for (const source of sources) {
    specifierByPath.set(
      source.name,
      `cf:module/${identityByPath.get(source.name)}`,
    );
  }
  const sourceByName = new Map(sources.map((s) => [s.name, s]));

  // Pre-pass: each module's direct export names + its `export *` targets, then
  // resolve the full export set (unioning `export *` targets transitively).
  // `export *` does not re-export the `default` binding. Module hashes already
  // fold in transitive import content, so per-module caching stays valid.
  const rawExports = new Map<string, ModuleExports>();
  for (const source of sources) {
    rawExports.set(source.name, collectModuleExports(source));
  }
  const fullExportsMemo = new Map<string, string[]>();
  const resolveFullExports = (name: string): string[] => {
    const memo = fullExportsMemo.get(name);
    if (memo) return memo;
    // Walk the transitive closure of `export *` edges first (worklist with a
    // visited set, so cycles of any length terminate and contribute fully),
    // then union the reachable modules' direct export names. Computing the full
    // closure before unioning avoids the memo-poisoning a recursive
    // partial-result scheme would suffer inside a cycle.
    const reachableInternal = new Set<string>();
    const runtimeNames = new Set<string>();
    const stack = [name];
    const walked = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (walked.has(current)) continue;
      walked.add(current);
      const raw = rawExports.get(current);
      const source = sourceByName.get(current);
      if (!raw || !source) continue;
      for (const targetSpec of raw.starTargets) {
        const aliased = options.specifierAliases?.get(targetSpec);
        const internal = aliased ??
          findInternalTarget(
            fileNames,
            resolveImportSpecifier(targetSpec, source),
          );
        if (internal !== undefined) {
          if (!fileNames.has(internal)) {
            throw new Error(
              `specifier alias '${targetSpec}' -> '${internal}' does not name a program file`,
            );
          }
          reachableInternal.add(internal);
          stack.push(internal);
        } else {
          for (const n of runtimeModules[targetSpec] ?? []) runtimeNames.add(n);
        }
      }
    }
    // Own direct exports (default kept); re-exported names exclude `default`.
    const names = new Set<string>(rawExports.get(name)?.names ?? []);
    for (const target of reachableInternal) {
      for (const n of rawExports.get(target)?.names ?? []) {
        if (n !== "default") names.add(n);
      }
    }
    for (const n of runtimeNames) {
      if (n !== "default") names.add(n);
    }
    const result = [...names];
    fullExportsMemo.set(name, result);
    return result;
  };

  const records = new Map<string, VirtualModuleRecord>();
  const compiledBodies = new Map<string, string>();
  const moduleSourceMaps = new Map<string, SourceMap>();
  const registrationSink: HoistRegistrationSink = new Map();
  const registrationApproved = new Set<string>();
  for (const source of sources) {
    const specifier = specifierByPath.get(source.name)!;
    const moduleHash = identityByPath.get(source.name)!;
    const sourceMap = options.precompiledSourceMaps?.get(source.name);
    if (sourceMap) moduleSourceMaps.set(specifier, sourceMap);
    const precompiled = options.precompiledBodies?.get(source.name);
    let exportNames: string[];
    let compiled: string;
    // A precompiled (CF-transformed) body is authoritative. Do NOT consult or
    // populate the shared cache: it may hold a bare-transpiled body under the
    // same content-hash key (different compilation mode), which must not mix.
    const cached = precompiled === undefined
      ? options.recordCache?.get(moduleHash)
      : undefined;
    if (precompiled !== undefined) {
      exportNames = resolveFullExports(source.name);
      compiled = precompiled;
    } else if (cached) {
      exportNames = cached.exports;
      compiled = cached.compiled;
    } else {
      exportNames = resolveFullExports(source.name);
      compiled = ts.transpileModule(source.contents, {
        fileName: source.name,
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: TARGET,
          esModuleInterop: true,
        },
      }).outputText;
      options.recordCache?.set(moduleHash, { exports: exportNames, compiled });
    }

    // Runtime imports are exactly the `require()` calls in the compiled output.
    // Type-only imports (`import type`, inline `import("…")` type refs) are
    // erased by the compiler and never appear here, so they correctly do not
    // become record edges — unlike `collectImportSpecifiers`, which includes
    // them for module *identity*.
    compiledBodies.set(specifier, compiled);
    const importSpecs = extractRuntimeImports(compiled);
    const resolutions: Record<string, string> = {};
    for (const spec of importSpecs) {
      const resolved = resolveImportSpecifier(spec, source);
      const internal = findInternalTarget(fileNames, resolved);
      if (internal !== undefined) {
        resolutions[spec] = specifierByPath.get(internal)!;
      } else if (spec in runtimeModules) {
        resolutions[spec] = `cf:runtime/${spec}`;
      } else if (options.specifierAliases?.has(spec)) {
        const target = options.specifierAliases.get(spec)!;
        const targetSpecifier = specifierByPath.get(target);
        if (targetSpecifier === undefined) {
          throw new Error(
            `specifier alias '${spec}' -> '${target}' does not name a program file`,
          );
        }
        resolutions[spec] = targetSpecifier;
      } else {
        // Unknown external; leave as-is so a missing-record error is explicit.
        resolutions[spec] = spec;
      }
    }

    // Expose `__esModule` on the namespace so that an importer compiled with
    // esModuleInterop (`__importDefault`) reads this module's `default` export
    // rather than wrapping the whole namespace. Authored sources are ESM.
    const namespaceExports = [...exportNames, "__esModule"];

    // Tag the eval with a sourceURL = the (prefixed) source path. Under Deno's
    // tamed SES `errorTaming` this is stripped from `new Error().stack`, so the
    // stack-based resolver (`resolveSourceLocationFromStack`) does not fire there
    // — but full source-location fidelity under the ESM loader is nonetheless
    // achieved (scheduler content-addressed implementation hash + CFC
    // verified-source) via two mechanisms, so this is NOT a remaining blocker for
    // enabling the flag by default:
    //   1. Deno: the `indexOf`-into-`script` fallback in
    //      `resolveLocationFromFunctionSource` (builder/module.ts) maps `fn.src`
    //      to the canonical `cf:module/<hash>/<path>` form via the per-load
    //      `sourceLocationContext` the engine pushes.
    //   2. Browsers (which DO surface the per-module eval frame in stacks): the
    //      engine registers a per-module source map keyed on THIS `sourceURL`
    //      (engine.ts, near `loadSourceMap`), so the stack-based resolver
    //      translates the eval coordinate back to the authored source.
    // Both paths are covered: `esm-source-location.test.ts` (CFC verified-source
    // parity, flag-on) and `action-fingerprint.test.ts` (scheduler hash).
    //
    // SECURITY: strip JS line terminators before interpolating into the
    // `//# sourceURL=` line comment. A newline (or U+2028/U+2029) in
    // `source.name` would otherwise end the comment and let the remainder of
    // the name execute as code inside the compartment.
    const sourceUrl = source.name.replace(/[\r\n\u2028\u2029]/g, "_");
    records.set(specifier, {
      imports: importSpecs,
      exports: namespaceExports,
      resolutions,
      execute: (moduleExports, compartment, resolvedImports) => {
        // Evaluate the compiled CommonJS body inside the SES compartment so it
        // runs under lockdown with confined globals. `__cfReg` is the 4th
        // parameter — the per-module hoist registrar — which shadows the no-op
        // `__cfReg` compartment global inside this wrapper.
        const factory = compartment.evaluate(
          `(function (exports, require, module, __cfReg) {\n${compiled}\n})\n//# sourceURL=${sourceUrl}`,
        ) as (
          exports: Record<string, unknown>,
          require: (specifier: string) => Record<string, unknown>,
          module: { exports: Record<string, unknown> },
          register: (entries: Record<string, unknown>) => void,
        ) => void;
        // The module body writes its exports into a WRITE-ONCE object rather
        // than a plain mutable one. The verifier cannot see a write smuggled
        // into an accepted expression's evaluation (e.g. a comma side effect
        // inside a `__cf_data(...)` argument: `__cf_data((exports.x = evil, 1))`),
        // so a body could otherwise overwrite an already-assigned export with an
        // attacker-controlled value before we snapshot it into the namespace.
        // Write-once makes any re-assignment / redefinition / deletion of an
        // already-populated export throw, so the smuggle fails closed. A `void 0`
        // forward declaration is treated as a placeholder, so the canonical
        // `exports.x = void 0; … exports.x = real;` compiler shape is allowed.
        const requireShim = (specifier: string) =>
          compartment.importNow(resolvedImports[specifier] ?? specifier);
        // A throw inside the factory is terminal for this module: SES caches the
        // error and re-throws it on every subsequent importNow (the same
        // contract as a failed AMD factory).
        // Grant the real registrar ONLY if the verifier approved this module's
        // `__cfReg` call; otherwise a throwing one (fail closed).
        const { register, commit } = registrationApproved.has(specifier)
          ? createHoistRegistrar(moduleHash, registrationSink)
          : createRejectingRegistrar();
        populateModuleExports(
          moduleExports,
          exportNames,
          factory,
          requireShim,
          register,
        );
        // Reached only if the factory returned normally — commit staged hoist
        // registrations (transactional: a throw above skips this).
        commit();
      },
    });
  }

  return {
    records,
    specifierByPath,
    compiledBodies,
    moduleSourceMaps,
    registrationSink,
    registrationApproved,
  };
}

/** A compiled module loaded from the content-addressed cache (no TS source). */
export interface CachedCompiledModule {
  /** Prefix-free content identity (the `cf:module/<hash>` hash, no scheme). */
  identity: string;
  /** Normalized authored path (e.g. `/main.tsx`); used for the eval sourceURL. */
  filename: string;
  /** Compiled CommonJS body. */
  code: string;
  /** Internal import edges: require specifier → dependency module identity. */
  imports: { specifier: string; targetIdentity: string }[];
  /** Per-module source map, if cached. */
  sourceMap?: SourceMap;
}

/**
 * Unique per-module source name for a cached closure. A single program's
 * closure has unique filenames, but a fabric importer's closure also carries
 * its imported subtrees' modules, which routinely share names (`/main.tsx`).
 * The cached record path keys several side tables by source name
 * (`specifierByPath` → per-module source maps, export map,
 * `exportsByIdentity`; the engine's fn.src canonicalization) — a name
 * collision silently drops one module from all of them. Disambiguate
 * colliding names with the mount-root convention; a collision-free closure
 * keeps plain filenames (byte-identical to pre-fabric behavior).
 */
export function cachedModuleSourceNames(
  modules: readonly CachedCompiledModule[],
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const m of modules) {
    counts.set(m.filename, (counts.get(m.filename) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  for (const m of modules) {
    names.set(
      m.identity,
      counts.get(m.filename)! > 1
        ? `${FABRIC_MOUNT_ROOT}${m.identity}${m.filename}`
        : m.filename,
    );
  }
  return names;
}

/**
 * Build a verified-able record graph **directly from cached compiled modules** —
 * no TypeScript source, no `resolve`, no recompile. This is the warm load path:
 * the content-addressed cache already holds each module's compiled body + its
 * internal import edges (specifier → dependency identity), and the export
 * **names** are recovered from the compiled body itself (see
 * {@link extractCompiledExports}; `export *` is unioned transitively through the
 * cached edges). Runtime (`cf:runtime/*`) records are registered by the caller.
 *
 * Returns the same {@link CompiledModuleGraph} shape as
 * {@link compileSourcesToRecords}, keyed in identity space: `specifierByPath` is
 * keyed by each module's normalized `filename`.
 */
export function buildRecordsFromCompiled(
  modules: readonly CachedCompiledModule[],
  options: { runtimeModules?: Record<string, string[]> } = {},
): CompiledModuleGraph {
  const runtimeModules = options.runtimeModules ?? {};
  const specifierOf = (identity: string) => `cf:module/${identity}`;
  const byIdentity = new Map(modules.map((m) => [m.identity, m]));
  const sourceNames = cachedModuleSourceNames(modules);

  // Direct export names + `export *` edges (as dependency identities) per module.
  const direct = new Map<
    string,
    { names: Set<string>; starTargets: string[] }
  >();
  for (const m of modules) {
    const parsed = parseCompiledExports(m.code);
    const names = new Set<string>(parsed.exportNames);
    const starTargets: string[] = [];
    for (const spec of parsed.starTargetSpecs) {
      const edge = m.imports.find((i) => i.specifier === spec);
      if (edge) starTargets.push(edge.targetIdentity);
      else {for (const n of runtimeModules[spec] ?? []) {
          if (n !== "default") names.add(n);
        }}
    }
    direct.set(m.identity, { names, starTargets });
  }

  // Full export set: own names ∪ transitively re-exported names (minus default).
  const fullExportsMemo = new Map<string, string[]>();
  const resolveFullExports = (identity: string): string[] => {
    const memo = fullExportsMemo.get(identity);
    if (memo) return memo;
    const names = new Set<string>(direct.get(identity)?.names ?? []);
    const walked = new Set<string>();
    const stack = [...(direct.get(identity)?.starTargets ?? [])];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (walked.has(cur)) continue;
      walked.add(cur);
      for (const n of direct.get(cur)?.names ?? []) {
        if (n !== "default") names.add(n);
      }
      stack.push(...(direct.get(cur)?.starTargets ?? []));
    }
    const result = [...names];
    fullExportsMemo.set(identity, result);
    return result;
  };

  const records = new Map<string, VirtualModuleRecord>();
  const compiledBodies = new Map<string, string>();
  const moduleSourceMaps = new Map<string, SourceMap>();
  const specifierByPath = new Map<string, string>();
  const registrationSink: HoistRegistrationSink = new Map();
  const registrationApproved = new Set<string>();

  for (const m of modules) {
    const specifier = specifierOf(m.identity);
    specifierByPath.set(sourceNames.get(m.identity)!, specifier);
    compiledBodies.set(specifier, m.code);
    if (m.sourceMap) moduleSourceMaps.set(specifier, m.sourceMap);

    const importSpecs = [...parseCompiledImports(m.code)];
    const resolutions: Record<string, string> = {};
    for (const spec of importSpecs) {
      const edge = m.imports.find((i) => i.specifier === spec);
      if (edge !== undefined) {
        resolutions[spec] = specifierOf(edge.targetIdentity);
      } else if (spec in runtimeModules) {
        resolutions[spec] = `cf:runtime/${spec}`;
      } else {
        resolutions[spec] = spec;
      }
    }

    const exportNames = resolveFullExports(m.identity);
    const namespaceExports = [...exportNames, "__esModule"];
    const sourceUrl = sourceNames.get(m.identity)!.replace(
      /[\r\n\u2028\u2029]/g,
      "_",
    );
    const compiled = m.code;
    records.set(specifier, {
      imports: importSpecs,
      exports: namespaceExports,
      resolutions,
      execute: (moduleExports, compartment, resolvedImports) => {
        const factory = compartment.evaluate(
          `(function (exports, require, module, __cfReg) {\n${compiled}\n})\n//# sourceURL=${sourceUrl}`,
        ) as (
          exports: Record<string, unknown>,
          require: (specifier: string) => Record<string, unknown>,
          module: { exports: Record<string, unknown> },
          register: (entries: Record<string, unknown>) => void,
        ) => void;
        const requireShim = (spec: string) =>
          compartment.importNow(resolvedImports[spec] ?? spec);
        const { register, commit } = registrationApproved.has(specifier)
          ? createHoistRegistrar(m.identity, registrationSink)
          : createRejectingRegistrar();
        populateModuleExports(
          moduleExports,
          exportNames,
          factory,
          requireShim,
          register,
        );
        commit();
      },
    });
  }
  // Silence unused in the rare all-internal case.
  void byIdentity;

  return {
    records,
    specifierByPath,
    compiledBodies,
    moduleSourceMaps,
    registrationSink,
    registrationApproved,
  };
}

/**
 * Recover a compiled module's export surface by scanning its compiled CommonJS
 * body (no TS source): `exports.<name> = …`, `Object.defineProperty(exports,
 * "<name>", …)` (named re-exports), and `__exportStar(require("<spec>"), …)` for
 * `export *`. Returns the directly-declared names (minus `__esModule`) plus the
 * `export *` source specifiers (resolved to dependency identities by the caller).
 */
export function extractCompiledExports(
  compiled: string,
): { names: Set<string>; starTargetSpecs: string[] } {
  const sourceFile = ts.createSourceFile(
    "compiled.js",
    compiled,
    TARGET,
    true,
    ts.ScriptKind.JS,
  );
  const names = new Set<string>();
  const starTargetSpecs = new Set<string>();

  const isExportsRef = (node: ts.Expression): boolean =>
    ts.isIdentifier(node) && node.text === "exports";

  const requireArg = (node: ts.Expression): string | undefined => {
    if (
      ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === "require" && node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      return (node.arguments[0] as ts.StringLiteralLike).text;
    }
    return undefined;
  };

  function visit(node: ts.Node): void {
    // exports.<name> = …
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      isExportsRef(node.left.expression)
    ) {
      const name = node.left.name.text;
      if (name !== "__esModule") names.add(name);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined;
      // Object.defineProperty(exports, "<name>", …) — named re-export / getter.
      if (
        calleeName === "defineProperty" && node.arguments.length >= 2 &&
        isExportsRef(node.arguments[0]) &&
        ts.isStringLiteralLike(node.arguments[1])
      ) {
        const name = (node.arguments[1] as ts.StringLiteralLike).text;
        if (name !== "__esModule") names.add(name);
      }
      // __exportStar(require("<spec>"), exports) — `export *`.
      if (calleeName === "__exportStar" && node.arguments.length >= 1) {
        const spec = requireArg(node.arguments[0]);
        if (spec !== undefined) starTargetSpecs.add(spec);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { names, starTargetSpecs: [...starTargetSpecs] };
}

/**
 * Extract the runtime import specifiers actually emitted as `require()` calls
 * in the compiled CommonJS body. This is the precise runtime dependency set;
 * type-only imports have already been erased by the compiler.
 *
 * Parses the emitted JS AST and matches `require("literal")` call expressions,
 * rather than scanning text — so a `require(...)` appearing inside a string
 * literal, template literal, or comment in the authored source is NOT mistaken
 * for a real dependency edge.
 */
function extractRuntimeImports(compiled: string): string[] {
  const sourceFile = ts.createSourceFile(
    "compiled.js",
    compiled,
    TARGET,
    true,
    ts.ScriptKind.JS,
  );
  const out = new Set<string>();
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      out.add((node.arguments[0] as ts.StringLiteralLike).text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return [...out];
}

/** Collect bound identifier names from a (possibly destructuring) binding. */
function collectBindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  // Object/array binding patterns: `export const { a, b } = …` / `[x] = …`.
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      collectBindingNames(element.name, out);
    }
  }
}

/**
 * Statically collect the names a module exports (named, default, enum,
 * namespace, destructured). Throws loudly on forms this adapter does not yet
 * support, rather than producing a silently-incomplete namespace.
 */
/** Direct export names of a module plus the specifiers it `export *`s from. */
interface ModuleExports {
  names: string[];
  starTargets: string[];
}

function collectModuleExports(source: Source): ModuleExports {
  const sourceFile = ts.createSourceFile(
    source.name,
    source.contents,
    TARGET,
    true,
  );
  const names = new Set<string>();
  const starTargets: string[] = [];

  for (const statement of sourceFile.statements) {
    const isExported = ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((m) =>
        m.kind === ts.SyntaxKind.ExportKeyword
      );
    const isDefault = ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((m) =>
        m.kind === ts.SyntaxKind.DefaultKeyword
      );

    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) && isExported
    ) {
      if (isDefault) {
        names.add("default");
      } else if (statement.name) {
        names.add(statement.name.text);
      }
    } else if (
      (ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) && isExported
    ) {
      if (statement.name && ts.isIdentifier(statement.name)) {
        names.add(statement.name.text);
      }
    } else if (ts.isVariableStatement(statement) && isExported) {
      for (const decl of statement.declarationList.declarations) {
        collectBindingNames(decl.name, names);
      }
    } else if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals) {
        throw new Error(
          `${source.name}: 'export =' is not supported by the ESM module-record adapter (authored sources must be ES modules)`,
        );
      }
      names.add("default"); // `export default <expr>`
    } else if (ts.isExportDeclaration(statement)) {
      // `export type ...` re-exports are compile-time only; ignore them.
      if (statement.isTypeOnly) {
        continue;
      }
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        // `export { a, b }` or `export { a } from "./m"`; skip `export { type T }`.
        for (const element of clause.elements) {
          if (!element.isTypeOnly) {
            names.add(element.name.text);
          }
        }
      } else if (clause && ts.isNamespaceExport(clause)) {
        // `export * as ns from "./m"`.
        names.add(clause.name.text);
      } else if (
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        // Bare `export * from "./m"`: record the target so its export names can
        // be unioned in (resolved transitively by the caller).
        starTargets.push(statement.moduleSpecifier.text);
      }
    }
  }

  return { names: [...names], starTargets };
}
