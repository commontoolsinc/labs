import { type Diagnostic, type Program } from "typescript";
import { CompilerError, ErrorDetails } from "./errors.ts";

export class Checker {
  private program: Program;
  constructor(program: Program) {
    this.program = program;
  }

  typeCheck() {
    const errors = this.sources().reduce((output, sourceFile) => {
      const diagnostics = this.program.getSemanticDiagnostics(sourceFile);
      for (const diagnostic of diagnostics) {
        output.push({ diagnostic, source: sourceFile.text });
      }
      return output;
    }, [] as ErrorDetails[]);
    if (errors.length) {
      throw new CompilerError(errors);
    }
  }

  declarationCheck() {
    const errors = this.sources().reduce((output, sourceFile) => {
      const diagnostics = this.program.getDeclarationDiagnostics(sourceFile);
      for (const diagnostic of diagnostics) {
        output.push({ diagnostic, source: sourceFile.text });
      }
      return output;
    }, [] as ErrorDetails[]);
    if (errors.length) {
      throw new CompilerError(errors);
    }
  }

  check(diagnostics: readonly Diagnostic[] | undefined) {
    if (!diagnostics || diagnostics.length === 0) {
      return;
    }
    throw new CompilerError(diagnostics.map((diagnostic) => ({
      diagnostic,
    })));
  }

  private sources() {
    return this.program.getSourceFiles().filter((source) =>
      !source.fileName.startsWith("$types/")
    );
  }
}
