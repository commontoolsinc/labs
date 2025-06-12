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
    noEmitOnError: true,
    declarations: true,
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
    lib: [TARGET_TYPE_LIB, "dom"],
    // Dynamic import/requires and `<reference` pragmas
    // should not be respected.
    noResolve: true,
  };
};
