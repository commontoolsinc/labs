export {
  type BeforeTransformersResult,
  type TransformerPipelineResult,
  TypeScriptCompiler,
  type TypeScriptCompilerOptions,
} from "./compiler.ts";
export {
  CompilationError,
  type CompilationErrorType,
  CompilerError,
  type DiagnosticMessageTransformer,
  formatTransformerDiagnostic,
  setDiagnosticMessageTransformer,
  type TransformerDiagnosticInfo,
  TransformerError,
} from "./diagnostics/mod.ts";
export { getCompilerOptions, TARGET } from "./options.ts";
export {
  type ResolveModuleConfig,
  resolveProgram,
  type UnresolvedModuleHandling,
} from "./resolver.ts";
