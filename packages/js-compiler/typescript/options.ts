import type { CompilerOptions } from "typescript";
import {
  JsxEmit,
  ModuleKind,
  ScriptTarget,
  versionMajorMinor,
} from "typescript";

export const TARGET_TYPE_LIB = "es2023";
export const MODULE_KIND = ModuleKind.AMD;
export const TARGET = ScriptTarget.ES2023;
const IGNORE_DEPRECATIONS = Number(versionMajorMinor.split(".")[0] ?? "0") >= 6
  ? "6.0"
  : "5.0";

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
    // TypeScript warns on the legacy AMD + outFile bundling path. We still
    // rely on it today, so silence the deprecation for the active major.
    // Note: this first surfaced in CI through the compiled `cf` default-pattern
    // flow and was not fully reproducible in local harness tests.
    ignoreDeprecations: IGNORE_DEPRECATIONS,

    /**
     * Emit
     */

    removeComments: true,
    noEmitOnError: true,
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
