import ts from "typescript";
import { ImportRequirements } from "./imports.ts";

export type TransformMode = "transform" | "error";

export interface TransformationOptions {
  readonly mode?: TransformMode;
  readonly debug?: boolean;
}

export interface TransformationDiagnostic {
  readonly type: string;
  readonly message: string;
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
}

export interface DiagnosticInput {
  readonly type: string;
  readonly message: string;
  readonly node: ts.Node;
}

const DEFAULT_OPTIONS: Required<TransformationOptions> = {
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
  readonly options: Required<TransformationOptions>;
  readonly imports: ImportRequirements;
  readonly diagnostics: TransformationDiagnostic[] = [];
  #typeCache = new Map<ts.Node, ts.Type>();

  constructor(config: TransformationContextConfig) {
    this.program = config.program;
    this.checker = config.program.getTypeChecker();
    this.factory = config.transformation.factory;
    this.sourceFile = config.sourceFile;
    this.imports = config.imports ?? new ImportRequirements();
    this.options = {
      ...DEFAULT_OPTIONS,
      ...config.options,
    };
  }

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
