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
    // CT-1143: noEmitOnError + declaration + outFile is a known pathological
    // combination in TypeScript that causes multiple passes and exponential
    // memory usage. See https://github.com/Microsoft/TypeScript/issues/7221
    noEmitOnError: false,
    // CT-1143: declaration: true requires the full type graph to be resolved
    // for .d.ts generation, which is not needed for pattern compilation.
    declaration: false,
    // CT-1143: Skip type-checking of declaration files to reduce memory usage
    skipLibCheck: true,
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
