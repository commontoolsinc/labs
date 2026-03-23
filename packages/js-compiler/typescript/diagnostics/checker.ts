import { type Diagnostic, type Program } from "typescript";
import {
  CompilerError,
  type DiagnosticMessageTransformer,
  ErrorDetails,
} from "./errors.ts";

export interface CheckerOptions {
  messageTransformer?: DiagnosticMessageTransformer;
}

// These symbols are exported from commontools but TypeScript's declaration
// diagnostics have trouble with unique symbols in certain contexts.
// Filter out these known false positives.
// Note: TypeScript emits different phrasings for the same underlying issue:
//   - "private name 'X'" (TS4053/4054) for symbols used as property keys
//   - "name 'X' from external module" (TS4055) when the symbol type leaks into inferred declarations
const KNOWN_EXPORTED_SYMBOLS = [
  "CELL_BRAND",
  "CELL_INNER_TYPE",
  "DEFAULT_MARKER",
];

const KNOWN_INTENTIONAL_OPTION_DEPRECATIONS = [
  "Option 'outFile' is deprecated",
  "Option 'module=AMD' is deprecated",
];

function getDiagnosticMessageText(diagnostic: Diagnostic): string {
  return typeof diagnostic.messageText === "string"
    ? diagnostic.messageText
    : diagnostic.messageText.messageText;
}

function shouldIgnoreDiagnostic(diagnostic: Diagnostic): boolean {
  const message = getDiagnosticMessageText(diagnostic);
  return KNOWN_INTENTIONAL_OPTION_DEPRECATIONS.some((snippet) =>
    message.includes(snippet)
  );
}

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
        if (shouldIgnoreDiagnostic(diagnostic)) {
          continue;
        }
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
        if (shouldIgnoreDiagnostic(diagnostic)) {
          continue;
        }
        // Skip "private name" errors for known exported symbols
        const message = getDiagnosticMessageText(diagnostic);
        const isKnownSymbol = KNOWN_EXPORTED_SYMBOLS.some((sym) =>
          message.includes(`private name '${sym}'`) ||
          message.includes(`name '${sym}' from external module`)
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

  check(diagnostics: readonly Diagnostic[] | undefined) {
    const filteredDiagnostics = diagnostics?.filter((diagnostic) =>
      !shouldIgnoreDiagnostic(diagnostic)
    );
    if (!filteredDiagnostics || filteredDiagnostics.length === 0) {
      return;
    }
    throw new CompilerError(
      filteredDiagnostics.map((diagnostic) => ({ diagnostic })),
      this.messageTransformer,
    );
  }

  private sources() {
    return this.program.getSourceFiles().filter((source) =>
      !source.fileName.startsWith("$types/")
    );
  }
}
