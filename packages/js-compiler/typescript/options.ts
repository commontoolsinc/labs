import type { CompilerOptions } from "typescript";
import { JsxEmit, ModuleKind, ScriptTarget } from "typescript";

export const TARGET_TYPE_LIB = "es2023";
export const MODULE_KIND = ModuleKind.AMD;
export const TARGET = ScriptTarget.ES2023;

export const getCompilerOptions = (): CompilerOptions => {
  return {
    /**
     * Typechecking
     */

    strict: true,
    strictNullChecks: true,
    strictFunctionTypes: true,

    /**
     * Module
     */

    // Emitting a concatenated/bundled output requires
    // a compatible module type (AMD and SystemJS). Using
    // AMD for ease of writing an inline bundler.
    module: MODULE_KIND,

    /**
     * Emit
     */

    removeComments: true,
    // Semantic and emit diagnostics are checked explicitly in the compiler.
    // Keep emit enabled so intentional option deprecations do not suppress
    // output in environments that surface AMD/outFile warnings as errors.
    noEmitOnError: false,
    // Note: declaration emit is disabled because TypeScript's declaration emit
    // has trouble with unique symbols (CELL_BRAND, CELL_INNER_TYPE) in exported
    // types, causing emit to skip entirely. Declaration checking is done
    // explicitly via checker.declarationCheck() instead.
    declaration: false,
    // Enable source map generation.
    sourceMap: true,
    // We want the source map to include the original TypeScript files
    inlineSources: true,
    // Generate separate source map instead of inline
    inlineSourceMap: false,

    /**
     * JavaScript
     */

    allowJs: true,

    /**
     * Interop
     */

    forceConsistentCasingInFileNames: true,
    esModuleInterop: true,
    isolatedModules: false,

    /**
     * Language and Environment
     */

    jsx: JsxEmit.React,
    jsxFactory: "h",
    jsxFragmentFactory: "h.fragment",
    target: TARGET,
    // `lib` should autoapply, but we need to manage default libraries since
    // we are running outside of node. Ensure this lib matches `target`.
    lib: [TARGET_TYPE_LIB, "dom", "jsx"],
    // Dynamic import/requires and `<reference` pragmas
    // should not be respected.
    noResolve: true,
  };
};
