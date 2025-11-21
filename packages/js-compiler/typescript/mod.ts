export {
  TypeScriptCompiler,
  type TypeScriptCompilerOptions,
} from "./compiler.ts";
export {
  CompilationError,
  type CompilationErrorType,
  CompilerError,
} from "./diagnostics/mod.ts";
export { getCompilerOptions, TARGET } from "./options.ts";
export {
  type ResolveModuleConfig,
  resolveProgram,
  type UnresolvedModuleHandling,
} from "./resolver.ts";
