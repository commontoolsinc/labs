import { ensureSESLockdown } from "./ses-runtime.ts";

/**
 * SES module-graph loader (Phase 2 of docs/specs/module-loading.md).
 *
 * Loads a graph of per-module records through the SES Compartment module
 * system using synchronous `importNow`, instead of evaluating one flattened
 * AMD bundle. Modules are addressed by content-addressed specifiers
 * (`cf:module/<hash>`), and runtime modules (`commonfabric`, …) are ordinary
 * records in the same graph.
 *
 * This version uses SES "virtual" (third-party) module records — `{ imports,
 * exports, execute }` — because this build of `ses` does not expose a
 * `ModuleSource`/`StaticModuleRecord` constructor. Records load synchronously,
 * preserving the scheduler's synchronous execution contract, and import cycles
 * resolve through lazy `compartment.importNow` inside `execute`.
 *
 * This is gated behind the `esmModuleLoader` experimental flag; the AMD bundle
 * path remains the default.
 */

/** A SES third-party (virtual) module record. */
export interface VirtualModuleRecord {
  /** Specifiers this module imports (as written in the module). */
  imports: string[];
  /** Names this module exports. */
  exports: string[];
  /**
   * Populate `moduleExports`. Use `compartment.importNow(resolvedImports[spec])`
   * to obtain an imported module's namespace.
   */
  execute(
    moduleExports: Record<string, unknown>,
    compartment: SesCompartment,
    resolvedImports: Record<string, string>,
  ): void;
}

interface SesCompartment {
  importNow(specifier: string): Record<string, unknown>;
}

interface SesCompartmentCtor {
  new (
    globals: Record<string, unknown>,
    moduleMap: Record<string, unknown>,
    options: {
      name?: string;
      resolveHook(importSpecifier: string, referrer: string): string;
      importNowHook(specifier: string): VirtualModuleRecord;
    },
  ): SesCompartment;
}

export interface SesModuleLoaderOptions {
  /** Records keyed by absolute (content-addressed) specifier. */
  records: Map<string, VirtualModuleRecord>;
  /** Global endowments for the compartment. */
  globals?: Record<string, unknown>;
  /** Optional compartment name, for diagnostics. */
  name?: string;
}

/**
 * Load `entrySpecifier` and its transitive dependencies synchronously,
 * returning the entry module's namespace.
 */
export function importModuleGraphNow(
  entrySpecifier: string,
  options: SesModuleLoaderOptions,
): Record<string, unknown> {
  ensureSESLockdown();
  const { records, globals = {}, name = "cf:esm" } = options;

  const CompartmentCtor = (globalThis as { Compartment?: SesCompartmentCtor })
    .Compartment;
  if (!CompartmentCtor) {
    throw new Error("SES Compartment is unavailable");
  }

  const compartment = new CompartmentCtor({ ...globals }, {}, {
    name,
    // Specifiers are already absolute and content-addressed, so resolution is
    // the identity function. (Relative specifiers are rewritten to absolute
    // content-addressed specifiers at compile time.)
    resolveHook: (importSpecifier: string) => importSpecifier,
    importNowHook: (specifier: string) => {
      const record = records.get(specifier);
      if (!record) {
        throw new Error(`Unknown module specifier: ${specifier}`);
      }
      return record;
    },
  });

  return compartment.importNow(entrySpecifier);
}
