import ts, { type Diagnostic, DiagnosticMessageChain } from "typescript";
import { renderInline } from "./render.ts";

export interface ErrorDetails {
  readonly diagnostic: Diagnostic;
  source?: string;
}

export type CompilationErrorType = "MODULE_NOT_FOUND" | "ERROR";

export class CompilationError {
  source?: string;
  file?: string;
  line?: number;
  column?: number;
  message: string;
  type: CompilationErrorType;

  constructor({ diagnostic, source }: ErrorDetails) {
    const { file, start } = diagnostic;
    const { message, type } = this.parseMessage(diagnostic.messageText);

    this.source = source;
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

  displayInline(): string {
    if (
      !this.source || this.line === undefined || this.column === undefined ||
      this.file === undefined
    ) {
      return this.display();
    }

    const inline = renderInline({
      source: this.source,
      line: this.line,
      column: this.column,
      contextLines: 2,
    });
    return `[${this.type}] ${this.message}\n${inline}`;
  }
}

export class CompilerError extends Error {
  override name = "CompilerError";
  #errors: CompilationError[];
  constructor(errorDetails: ErrorDetails[]) {
    const errors = errorDetails.map((d) => new CompilationError(d));
    const message = errors.map((error) => error.displayInline()).join("\n");
    super(message);
    this.#errors = errors;
  }
}
