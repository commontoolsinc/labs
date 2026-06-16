export type {
  Compiler,
  JsScript,
  Program,
  ProgramResolver,
  Source,
  SourceMap,
} from "./interface.ts";
export {
  type BeforeTransformersResult,
  CompilationError,
  type CompilationErrorType,
  CompilerError,
  type DiagnosticMessageTransformer,
  formatTransformerDiagnostic,
  type TransformerDiagnosticInfo,
  TransformerError,
  type TransformerPipelineResult,
  TypeScriptCompiler,
  type TypeScriptCompilerOptions,
} from "./typescript/mod.ts";
export {
  collectImportSpecifiers,
  resolveImportSpecifier,
} from "./typescript/resolver.ts";
export {
  FileSystemProgramResolver,
  HttpProgramResolver,
  InMemoryProgram,
} from "./program.ts";
export {
  composeBundleSourceMap,
  identitySourceMap,
  isSourceMap,
  type MappedPosition,
  parseSourceMap,
  SourceMapParser,
} from "./source-map.ts";
export { getTypeScriptEnvironmentTypes } from "./utils.ts";
