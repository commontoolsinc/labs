import ts from "typescript";
import { getLogger } from "@commonfabric/utils/logger";
import type { Source } from "@commonfabric/js-compiler";
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
  ) => void,
  requireShim: (specifier: string) => Record<string, unknown>,
): void {
  const writeOnceExports = createWriteOnceExports();
  const moduleObject = Object.freeze({ exports: writeOnceExports });
  factory(writeOnceExports, requireShim, moduleObject);
  for (const name of exportNames) {
    moduleExports[name] = hardenExportedValue(writeOnceExports[name]);
  }
  moduleExports.__esModule = true;
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
}

export interface CompiledModuleGraph {
  records: Map<string, VirtualModuleRecord>;
  /** Content-addressed specifier for each original file path. */
  specifierByPath: Map<string, string>;
  /** Compiled CommonJS body per specifier — the text the verifier classifies. */
  compiledBodies: Map<string, string>;
}

export function compileSourcesToRecords(
  sources: Source[],
  options: CompileSourcesOptions = {},
): CompiledModuleGraph {
  const runtimeModules = options.runtimeModules ?? {};
  const hashes = computeModuleHashes(
    { main: "", files: sources },
    options.runtimeFingerprint !== undefined
      ? { runtimeFingerprint: options.runtimeFingerprint }
      : {},
  );
  const fileNames = new Set(sources.map((s) => s.name));
  const specifierByPath = new Map<string, string>();
  for (const source of sources) {
    specifierByPath.set(source.name, `cf:module/${hashes.get(source.name)}`);
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
        const resolved = resolveImportSpecifier(targetSpec, source);
        const internal = findInternalTarget(fileNames, resolved);
        if (internal !== undefined) {
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
  for (const source of sources) {
    const specifier = specifierByPath.get(source.name)!;
    const moduleHash = hashes.get(source.name)!;
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
      } else {
        // Unknown external; leave as-is so a missing-record error is explicit.
        resolutions[spec] = spec;
      }
    }

    // Expose `__esModule` on the namespace so that an importer compiled with
    // esModuleInterop (`__importDefault`) reads this module's `default` export
    // rather than wrapping the whole namespace. Authored sources are ESM.
    const namespaceExports = [...exportNames, "__esModule"];

    // Tag the eval with a sourceURL = the (prefixed) source path. NOTE: under
    // SES `errorTaming` this is currently stripped from stack traces, so it
    // does NOT yet make `fn.src` resolve — full source-location fidelity under
    // the ESM loader (stack traces, and thus the scheduler's content-addressed
    // implementation hash / CFC verified-source check) requires SES-isolate-
    // level source-map integration and is tracked as the remaining item before
    // the flag can be enabled by default. The tag is the hook for that work.
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
        // runs under lockdown with confined globals.
        const factory = compartment.evaluate(
          `(function (exports, require, module) {\n${compiled}\n})\n//# sourceURL=${sourceUrl}`,
        ) as (
          exports: Record<string, unknown>,
          require: (specifier: string) => Record<string, unknown>,
          module: { exports: Record<string, unknown> },
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
        populateModuleExports(
          moduleExports,
          exportNames,
          factory,
          requireShim,
        );
      },
    });
  }

  return { records, specifierByPath, compiledBodies };
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
