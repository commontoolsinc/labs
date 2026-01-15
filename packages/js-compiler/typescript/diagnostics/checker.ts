import { type Diagnostic, type Program } from "typescript";
import {
  CompilerError,
  type DiagnosticMessageTransformer,
  ErrorDetails,
} from "./errors.ts";

export interface CheckerOptions {
  messageTransformer?: DiagnosticMessageTransformer;
}

// These symbols are exported from commontools but TypeScript's declaration emit
// has trouble with unique symbols in certain contexts. Filter out false positives.
const KNOWN_EXPORTED_SYMBOLS = ["CELL_BRAND", "CELL_INNER_TYPE"];

export class Checker {
  private program: Program;
  private messageTransformer?: DiagnosticMessageTransformer;

  constructor(program: Program, options: CheckerOptions = {}) {
    this.program = program;
    this.messageTransformer = options.messageTransformer;
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
      throw new CompilerError(errors, this.messageTransformer);
    }
  }

  declarationCheck() {
    const errors = this.sources().reduce((output, sourceFile) => {
      const diagnostics = this.program.getDeclarationDiagnostics(sourceFile);
      for (const diagnostic of diagnostics) {
        // Skip "private name" errors for known exported symbols
        const message = typeof diagnostic.messageText === "string"
          ? diagnostic.messageText
          : diagnostic.messageText.messageText;
        const isKnownSymbol = KNOWN_EXPORTED_SYMBOLS.some((sym) =>
          message.includes(`private name '${sym}'`)
        );
        if (!isKnownSymbol) {
          output.push({ diagnostic, source: sourceFile.text });
        }
      }
      return output;
    }, [] as ErrorDetails[]);
    if (errors.length) {
      throw new CompilerError(errors, this.messageTransformer);
    }
  }

  /**
   * Checks diagnostics and throws if there are real errors.
   * Returns true if there were diagnostics that were all filtered out
   * (known false positives), false if no diagnostics at all.
   */
  check(diagnostics: readonly Diagnostic[] | undefined): boolean {
    if (!diagnostics || diagnostics.length === 0) {
      return false;
    }
    // Filter out false positives for known exported symbols
    const filtered = diagnostics.filter((diagnostic) => {
      const message = typeof diagnostic.messageText === "string"
        ? diagnostic.messageText
        : diagnostic.messageText.messageText;
      return !KNOWN_EXPORTED_SYMBOLS.some((sym) =>
        message.includes(`private name '${sym}'`)
      );
    });
    if (filtered.length === 0) {
      // All diagnostics were filtered out - they were benign
      return true;
    }
    throw new CompilerError(
      filtered.map((diagnostic) => ({ diagnostic })),
      this.messageTransformer,
    );
  }

  private sources() {
    return this.program.getSourceFiles().filter((source) =>
      !source.fileName.startsWith("$types/")
    );
  }
}
