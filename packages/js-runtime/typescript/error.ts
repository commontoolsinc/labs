import ts, { type Diagnostic, DiagnosticMessageChain } from "typescript";

export type CompilationErrorType = "MODULE_NOT_FOUND" | "ERROR";

export class CompilationError {
  file?: string;
  line?: number;
  column?: number;
  message: string;
  type: CompilationErrorType;

  constructor(diagnostic: Diagnostic) {
    const { file, start } = diagnostic;
    const { message, type } = this.parseMessage(diagnostic.messageText);

    this.message = message;
    this.type = type;

    if (file) {
      this.file = file.fileName;
    }
    if (file && start !== undefined) {
      const result = file.getLineAndCharacterOfPosition(start);
      // TypeScript uses 0-based positions
      this.line = result.line + 1;
      this.column = result.character + 1;
    }
  }

  private parseMessage(
    input: string | DiagnosticMessageChain,
  ): { type: CompilationErrorType; message: string } {
    const message = ts.flattenDiagnosticMessageText(input, "\n");
    {
      const match = message.match(/^(Cannot find module '[^\']*'.)/);
      if (match && match.length >= 2) {
        // Strip out the extra message info on internal typescript
        // moduleResolution configuration
        return { type: "MODULE_NOT_FOUND", message: match[1] };
      }
    }
    return { type: "ERROR", message };
  }

  display(): string {
    const file = this.file ?? "";
    const location = this.line !== undefined && this.column !== undefined
      ? `:${this.line}:${this.column}`
      : "";
    const source = file ? ` [${file}${location}]` : "";
    return `[${this.type}] ${this.message}${source}`;
  }
}

export class CompilerError extends Error {
  override name = "CompilerError";
  errors: CompilationError[];
  constructor(diagnostics: readonly Diagnostic[]) {
    const errors = diagnostics.map((d) => new CompilationError(d));
    const message = errors.map((error) => error.display()).join("\n");
    super(message);
    this.errors = errors;
  }

  // Generates and throws an error if any diagnostics found in the input.
  static check(diagnostics: readonly Diagnostic[] | undefined) {
    if (!diagnostics || diagnostics.length === 0) {
      return;
    }
    throw new CompilerError(diagnostics);
  }
}
