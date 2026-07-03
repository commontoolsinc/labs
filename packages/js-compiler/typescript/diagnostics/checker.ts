import { type Diagnostic, type Program, type SourceFile } from "typescript";
import {
  CompilerError,
  type DiagnosticMessageTransformer,
  ErrorDetails,
} from "./errors.ts";

export interface CheckerOptions {
  messageTransformer?: DiagnosticMessageTransformer;
}

// These symbols are exported from commonfabric but TypeScript's declaration
// diagnostics have trouble with unique symbols in certain contexts.
// Filter out these known false positives.
// Note: TypeScript emits different phrasings for the same underlying issue:
//   - "private name 'X'" (TS4053/4054) for symbols used as property keys
//   - "name 'X' from external module" (TS4055) when the symbol type leaks into inferred declarations
const KNOWN_EXPORTED_SYMBOLS = [
  "CELL_BRAND",
  "CELL_INNER_TYPE",
  "DEFAULT_MARKER",
  "SCOPE_BRAND",
];

export class Checker {
  private program: Program;
  private messageTransformer?: DiagnosticMessageTransformer;

  constructor(program: Program, options: CheckerOptions = {}) {
    this.program = program;
    this.messageTransformer = options.messageTransformer;
  }

  typeCheck() {
    this.throwIfErrors(
      this.checkableSources().flatMap((sourceFile) =>
        this.collectSemanticErrors(sourceFile)
      ),
    );
  }

  declarationCheck() {
    this.throwIfErrors(
      this.checkableSources().flatMap((sourceFile) =>
        this.collectDeclarationErrors(sourceFile)
      ),
    );
  }

  /**
   * The source files {@link typeCheck}/{@link declarationCheck} cover, for
   * callers that step through them one file at a time (e.g. to yield to the
   * event loop between files) while keeping the same aggregate-then-throw
   * error semantics via {@link throwIfErrors}.
   */
  checkableSources(): SourceFile[] {
    return this.sources();
  }

  /** Per-file semantic diagnostics, as the error details typeCheck throws. */
  collectSemanticErrors(sourceFile: SourceFile): ErrorDetails[] {
    return this.program.getSemanticDiagnostics(sourceFile).map(
      (diagnostic) => ({ diagnostic, source: sourceFile.text }),
    );
  }

  /**
   * Per-file declaration diagnostics, filtered exactly as declarationCheck
   * filters them (known exported-symbol false positives skipped).
   */
  collectDeclarationErrors(sourceFile: SourceFile): ErrorDetails[] {
    const errors: ErrorDetails[] = [];
    for (const diagnostic of this.program.getDeclarationDiagnostics(sourceFile)) {
      // Skip "private name" errors for known exported symbols
      const message = typeof diagnostic.messageText === "string"
        ? diagnostic.messageText
        : diagnostic.messageText.messageText;
      const isKnownSymbol = KNOWN_EXPORTED_SYMBOLS.some((sym) =>
        message.includes(`private name '${sym}'`) ||
        message.includes(`name '${sym}' from external module`)
      );
      if (!isKnownSymbol) {
        errors.push({ diagnostic, source: sourceFile.text });
      }
    }
    return errors;
  }

  throwIfErrors(errors: ErrorDetails[]) {
    if (errors.length) {
      throw new CompilerError(errors, this.messageTransformer);
    }
  }

  check(diagnostics: readonly Diagnostic[] | undefined) {
    if (!diagnostics || diagnostics.length === 0) {
      return;
    }
    throw new CompilerError(
      diagnostics.map((diagnostic) => ({ diagnostic })),
      this.messageTransformer,
    );
  }

  private sources() {
    return this.program.getSourceFiles().filter((source) =>
      !source.fileName.startsWith("$types/")
    );
  }
}
