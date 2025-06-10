import type { CompilerOptions } from "typescript";
import { JsxEmit, ModuleKind, ScriptTarget } from "typescript";

export const TARGET_TYPE_LIB = "es2023";
export const MODULE_KIND = ModuleKind.AMD;
export const TARGET = ScriptTarget.ES2023;

export const getCompilerOptions = (): CompilerOptions => {
  return {
    declarations: true,
    module: MODULE_KIND,
    target: TARGET,
    // `lib` should autoapply, but we need to manage default libraries since
    // we are running outside of node. Ensure this lib matches `target`.
    lib: [TARGET_TYPE_LIB, "dom"],
    strict: true,
    isolatedModules: false,
    jsx: JsxEmit.React,
    jsxFactory: "h",
    jsxFragmentFactory: "h.fragment",
    esModuleInterop: true,
    noEmitOnError: true,
    // Dynamic import/requires should not be added.
    noResolve: true,
    // Enable source map generation.
    sourceMap: true,
    // We want the source map to include the original TypeScript files
    inlineSources: true,
    // Generate separate source map instead of inline
    inlineSourceMap: false,
  };
};
