import ts, { type Diagnostic, DiagnosticMessageChain } from "typescript";
import { renderInline } from "./render.ts";

/**
 * Interface for transforming diagnostic error messages.
 * Implementations can convert confusing TypeScript errors into clearer messages.
 */
export interface DiagnosticMessageTransformer {
  /**
   * Transform a diagnostic message.
   * @param message The original TypeScript diagnostic message
   * @returns Transformed message, or null if no transformation applies
   */
  transform(message: string): string | null;
}

/**
 * Global diagnostic message transformer.
 * Set via setDiagnosticMessageTransformer() before compilation.
 */
let globalMessageTransformer: DiagnosticMessageTransformer | undefined;

/**
 * Set the global diagnostic message transformer.
 * This transformer will be used to transform TypeScript error messages
 * into more user-friendly messages.
 */
export function setDiagnosticMessageTransformer(
  transformer: DiagnosticMessageTransformer | undefined,
): void {
  globalMessageTransformer = transformer;
}

export interface ErrorDetails {
  readonly diagnostic: Diagnostic;
  source?: string;
}

/**
 * Represents a diagnostic from the CommonTools transformer pipeline.
 * This mirrors TransformationDiagnostic from @commontools/ts-transformers.
 */
export interface TransformerDiagnosticInfo {
  readonly severity: "error" | "warning";
  readonly type: string;
  readonly message: string;
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
  readonly start: number;
  readonly length: number;
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

    // Apply custom message transformer if configured
    if (globalMessageTransformer) {
      const transformed = globalMessageTransformer.transform(message);
      if (transformed !== null) {
        return { type: "ERROR", message: transformed };
      }
    }

    // Detect module not found errors
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

  get errors(): CompilationError[] {
    return this.#errors;
  }
}

/**
 * Formats a transformer diagnostic with source context.
 * Returns a string like:
 * ```
 * /path/to/file.ts:10:5 - error: Message here
 *  8 | previous line
 *  9 | another line
 * 10 | error line
 *    |     ^
 * 11 | next line
 * ```
 */
export function formatTransformerDiagnostic(
  diagnostic: TransformerDiagnosticInfo,
  source: string,
): string {
  const prefix = diagnostic.severity === "error" ? "error" : "warning";
  const header =
    `${diagnostic.fileName}:${diagnostic.line}:${diagnostic.column} - ${prefix}: ${diagnostic.message}`;

  const inline = renderInline({
    source,
    line: diagnostic.line,
    column: diagnostic.column,
    contextLines: 2,
  });

  return `${header}\n${inline}`;
}

/**
 * Error thrown when the transformer pipeline reports errors.
 */
export class TransformerError extends Error {
  override name = "TransformerError";
  readonly diagnostics: TransformerDiagnosticInfo[];

  constructor(
    diagnostics: TransformerDiagnosticInfo[],
    sources: Map<string, string>,
  ) {
    const messages = diagnostics.map((d) => {
      const source = sources.get(d.fileName) ?? "";
      return formatTransformerDiagnostic(d, source);
    });
    super(messages.join("\n\n"));
    this.diagnostics = diagnostics;
  }
}
