import ts from "typescript";
import { ImportRequirements } from "./imports.ts";
import {
  DiagnosticInput,
  TransformationDiagnostic,
  TransformationOptions,
} from "./types.ts";

const DEFAULT_OPTIONS: TransformationOptions = {
  mode: "transform",
  debug: false,
};

export interface TransformationContextConfig {
  program: ts.Program;
  sourceFile: ts.SourceFile;
  transformation: ts.TransformationContext;
  options?: TransformationOptions;
  imports?: ImportRequirements;
}

export class TransformationContext {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly factory: ts.NodeFactory;
  readonly sourceFile: ts.SourceFile;
  readonly options: TransformationOptions;
  readonly imports: ImportRequirements;
  readonly diagnostics: TransformationDiagnostic[] = [];
  readonly transformation: ts.TransformationContext;
  #typeCache = new Map<ts.Node, ts.Type>();

  constructor(config: TransformationContextConfig) {
    this.program = config.program;
    this.checker = config.program.getTypeChecker();
    this.transformation = config.transformation;
    this.factory = config.transformation.factory;
    this.sourceFile = config.sourceFile;
    this.imports = config.imports ?? new ImportRequirements();
    this.options = {
      ...DEFAULT_OPTIONS,
      ...config.options,
    };
  }

  // Currently unused function
  getType(node: ts.Node): ts.Type {
    const cached = this.#typeCache.get(node);
    if (cached) {
      return cached;
    }
    const type = this.checker.getTypeAtLocation(node);
    this.#typeCache.set(node, type);
    return type;
  }

  reportDiagnostic(input: DiagnosticInput): void {
    const location = this.sourceFile.getLineAndCharacterOfPosition(
      input.node.getStart(),
    );
    this.diagnostics.push({
      type: input.type,
      message: input.message,
      fileName: this.sourceFile.fileName,
      line: location.line + 1,
      column: location.character + 1,
    });
  }
}
