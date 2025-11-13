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
        // Skip MODULE_NOT_FOUND errors for HTTP(S) URLs
        // These are resolved at runtime and don't need type checking
        if (this.isUrlModuleError(diagnostic)) {
          continue;
        }
        output.push({ diagnostic, source: sourceFile.text });
      }
      return output;
    }, [] as ErrorDetails[]);
    if (errors.length) {
      throw new CompilerError(errors);
    }
  }

  private isUrlModuleError(diagnostic: Diagnostic): boolean {
    // Check if the error message contains an HTTP(S) URL
    const message = typeof diagnostic.messageText === "string"
      ? diagnostic.messageText
      : diagnostic.messageText.messageText;

    const isUrl = message.includes("http://") || message.includes("https://");

    // Check if this is a "Cannot find module" error
    // 2307 = Cannot find module
    // 2792 = Cannot find module (alternate code in some contexts)
    const isModuleNotFoundError = diagnostic.code === 2307 || diagnostic.code === 2792;

    return isUrl && isModuleNotFoundError;
  }

  declarationCheck() {
    const errors = this.sources().reduce((output, sourceFile) => {
      const diagnostics = this.program.getDeclarationDiagnostics(sourceFile);
      for (const diagnostic of diagnostics) {
        // Skip MODULE_NOT_FOUND errors for HTTP(S) URLs
        if (this.isUrlModuleError(diagnostic)) {
          continue;
        }
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

    // Filter out URL module errors
    const filteredDiagnostics = diagnostics.filter(
      (diagnostic) => !this.isUrlModuleError(diagnostic)
    );

    if (filteredDiagnostics.length === 0) {
      return;
    }

    throw new CompilerError(filteredDiagnostics.map((diagnostic) => ({
      diagnostic,
    })));
  }

  private sources() {
    return this.program.getSourceFiles().filter((source) =>
      !source.fileName.startsWith("$types/")
    );
  }
}
