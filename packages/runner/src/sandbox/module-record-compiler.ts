import ts from "typescript";
import type { Source } from "@commonfabric/js-compiler";
import {
  collectImportSpecifiers,
  resolveImportSpecifier,
} from "@commonfabric/js-compiler";
import { computeModuleHashes } from "../harness/module-identity.ts";
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
 * Scope: this adapter handles the common module shapes (named `export`s,
 * `export default`, relative imports, and bare runtime-module imports). It does
 * not yet run the Common Fabric transformer pipeline (that wiring is staged
 * with the Engine integration) and does not statically expand `export *`
 * re-exports.
 */

const TARGET = ts.ScriptTarget.ES2023;

const RESOLUTION_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".mjs",
  ".d.ts",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
  "/index.mts",
  "/index.mjs",
];

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
}

export interface CompiledModuleGraph {
  records: Map<string, VirtualModuleRecord>;
  /** Content-addressed specifier for each original file path. */
  specifierByPath: Map<string, string>;
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

  const records = new Map<string, VirtualModuleRecord>();
  for (const source of sources) {
    const specifier = specifierByPath.get(source.name)!;
    const importSpecs = collectImportSpecifiers(source, TARGET);
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

    const moduleHash = hashes.get(source.name)!;
    const cached = options.recordCache?.get(moduleHash);
    let exportNames: string[];
    let compiled: string;
    if (cached) {
      exportNames = cached.exports;
      compiled = cached.compiled;
    } else {
      exportNames = collectExportNames(source);
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

    records.set(specifier, {
      imports: importSpecs,
      exports: exportNames,
      resolutions,
      execute: (moduleExports, compartment, resolvedImports) => {
        // Evaluate the compiled CommonJS body inside the SES compartment so it
        // runs under lockdown with confined globals.
        const factory = compartment.evaluate(
          `(function (exports, require, module) {\n${compiled}\n})`,
        ) as (
          exports: Record<string, unknown>,
          require: (specifier: string) => Record<string, unknown>,
          module: { exports: Record<string, unknown> },
        ) => void;
        const localExports: Record<string, unknown> = {};
        const moduleObject = { exports: localExports };
        const requireShim = (specifier: string) =>
          compartment.importNow(resolvedImports[specifier] ?? specifier);
        factory(localExports, requireShim, moduleObject);
        const finalExports = moduleObject.exports;
        // Copy the declared exports onto the SES module namespace object.
        for (const name of exportNames) {
          moduleExports[name] = finalExports[name];
        }
      },
    });
  }

  return { records, specifierByPath };
}

function findInternalTarget(
  fileNames: Set<string>,
  resolved: string,
): string | undefined {
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = resolved + suffix;
    if (fileNames.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Statically collect the names a module exports (named + default). */
function collectExportNames(source: Source): string[] {
  const sourceFile = ts.createSourceFile(
    source.name,
    source.contents,
    TARGET,
    true,
  );
  const names = new Set<string>();

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
    } else if (ts.isVariableStatement(statement) && isExported) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          names.add(decl.name.text);
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      // `export default <expr>` or `export = <expr>`
      names.add("default");
    } else if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          names.add(element.name.text);
        }
      }
      // `export * from "..."` cannot be statically enumerated here; not
      // supported in this adapter scope.
    }
  }

  return [...names];
}
