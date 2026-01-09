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
  formatTransformerDiagnostic,
  type TransformerDiagnosticInfo,
  TransformerError,
  type TransformerPipelineResult,
  TypeScriptCompiler,
  type TypeScriptCompilerOptions,
} from "./typescript/mod.ts";
export {
  FileSystemProgramResolver,
  HttpProgramResolver,
  InMemoryProgram,
} from "./program.ts";
export {
  isSourceMap,
  type MappedPosition,
  parseSourceMap,
  SourceMapParser,
} from "./source-map.ts";
export { getTypeScriptEnvironmentTypes } from "./utils.ts";
