/**
 * Diagnostic Message Transformer
 *
 * Transforms TypeScript diagnostic messages into more user-friendly messages.
 * This allows ts-transformers to own the domain-specific error message logic
 * while js-compiler remains generic.
 */

/**
 * Interface for transforming diagnostic error messages.
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
 * Options for the Reactive error transformer.
 */
export interface ReactiveErrorTransformerOptions {
  /**
   * When true, appends the original TypeScript error to the transformed message.
   * Useful for debugging.
   */
  verbose?: boolean;
}

/**
 * Transforms confusing Reactive-related TypeScript errors into clear, actionable messages.
 *
 * For example, transforms:
 *   "Property 'get' does not exist on type 'OpaqueCell<number> & number'"
 * Into:
 *   "Unnecessary .get() call on a reactive value. This value can be accessed directly..."
 */
export class ReactiveErrorTransformer implements DiagnosticMessageTransformer {
  private verbose: boolean;

  constructor(options: ReactiveErrorTransformerOptions = {}) {
    this.verbose = options.verbose ?? false;
  }

  transform(message: string): string | null {
    // Detect .get() called on OpaqueCell/Reactive types
    // TypeScript error: "Property 'get' does not exist on type 'OpaqueCell<...> & ...'"
    const match = message.match(
      /^Property 'get' does not exist on type '(OpaqueCell<[^']*>)/,
    );

    if (match) {
      const clarification = `Unnecessary .get() call on a reactive value. ` +
        `This value can be accessed directly - remove .get(). ` +
        `Reactive values passed to pattern (except Writable<T> and Stream<T>) ` +
        `and results from computed() and lift() don't need .get(). ` +
        `Only Writable<T> requires .get() to read values.`;

      if (this.verbose) {
        return `${clarification}\n\nOriginal TypeScript error: ${message}`;
      }
      return clarification;
    }

    const asyncResultProperty = message.match(
      /^Property '(result|pending|error|partial)' does not exist on type 'AsyncResult<.*>'/,
    );
    if (asyncResultProperty) {
      const clarification =
        "Async built-ins now return AsyncResult<T> directly. Use " +
        "resultOf(request) for usable data, isPending(request) and " +
        "hasError(request) to branch on state, and partialResultOf(request) " +
        "for intermediate output from generateTextStream() or streamData().";
      return this.verbose
        ? `${clarification}\n\nOriginal TypeScript error: ${message}`
        : clarification;
    }

    return null; // No transformation applies
  }
}

/**
 * Combines multiple diagnostic message transformers.
 * Returns the first successful transformation, or null if none apply.
 */
export class CompositeDiagnosticTransformer
  implements DiagnosticMessageTransformer {
  private transformers: DiagnosticMessageTransformer[];

  constructor(transformers: DiagnosticMessageTransformer[]) {
    this.transformers = transformers;
  }

  transform(message: string): string | null {
    for (const transformer of this.transformers) {
      const result = transformer.transform(message);
      if (result !== null) {
        return result;
      }
    }
    return null;
  }
}
