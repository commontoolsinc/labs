/**
 * Execution wrapper for sandboxed pattern functions.
 *
 * This module provides wrappers that catch errors during pattern execution
 * and enhance them with debugging information. When source map support is
 * added (PR 2.2), errors will be mapped back to original source locations.
 */

import { SandboxSecurityError } from "./types.ts";

/**
 * Options for the execution wrapper.
 */
export interface ExecutionWrapperOptions {
  /**
   * The pattern ID for error attribution.
   */
  readonly patternId: string;

  /**
   * Optional function name for error context.
   */
  readonly functionName?: string;

  /**
   * Whether to include stack traces in errors.
   * Default: true in debug mode, false otherwise.
   */
  readonly includeStack?: boolean;

  /**
   * Whether debug mode is enabled.
   */
  readonly debug?: boolean;
}

/**
 * A wrapped function that includes error handling.
 */
// deno-lint-ignore no-explicit-any
export type WrappedFunction<T extends (...args: any[]) => any> = (
  ...args: Parameters<T>
) => ReturnType<T>;

/**
 * Error thrown during wrapped execution with enhanced context.
 */
export class PatternExecutionError extends Error {
  /**
   * The pattern ID where the error occurred.
   */
  readonly patternId: string;

  /**
   * The function name where the error occurred (if known).
   */
  readonly functionName?: string;

  /**
   * The original error that was caught.
   */
  readonly originalError: Error;

  /**
   * The mapped source location (if available after source map mapping).
   */
  readonly sourceLocation?: SourceLocation;

  constructor(
    message: string,
    patternId: string,
    originalError: Error,
    functionName?: string,
    sourceLocation?: SourceLocation,
  ) {
    super(message, { cause: originalError });
    this.name = "PatternExecutionError";
    this.patternId = patternId;
    this.originalError = originalError;
    this.functionName = functionName;
    this.sourceLocation = sourceLocation;
  }

  /**
   * Create a user-friendly error message.
   */
  toUserMessage(): string {
    const location = this.sourceLocation
      ? ` at ${this.sourceLocation.file}:${this.sourceLocation.line}:${this.sourceLocation.column}`
      : "";

    const fn = this.functionName ? ` in ${this.functionName}` : "";

    return `Error in pattern "${this.patternId}"${fn}${location}: ${this.originalError.message}`;
  }
}

/**
 * Source location for error mapping.
 */
export interface SourceLocation {
  /**
   * The source file path or URL.
   */
  readonly file: string;

  /**
   * 1-based line number.
   */
  readonly line: number;

  /**
   * 0-based column number.
   */
  readonly column: number;
}

/**
 * Create an execution wrapper for a pattern function.
 *
 * The wrapper catches any errors thrown during execution and wraps them
 * in a PatternExecutionError with additional context.
 *
 * @param fn - The function to wrap
 * @param options - Wrapper options
 * @returns The wrapped function
 *
 * @example
 * ```typescript
 * const wrappedFn = wrapExecution(
 *   (input) => compute(input),
 *   { patternId: "my-pattern", functionName: "compute" }
 * );
 *
 * try {
 *   const result = wrappedFn(data);
 * } catch (err) {
 *   if (err instanceof PatternExecutionError) {
 *     console.error(err.toUserMessage());
 *   }
 * }
 * ```
 */
// deno-lint-ignore no-explicit-any
export function wrapExecution<T extends (...args: any[]) => any>(
  fn: T,
  options: ExecutionWrapperOptions,
): WrappedFunction<T> {
  const { patternId, functionName, debug } = options;

  return ((...args: Parameters<T>): ReturnType<T> => {
    try {
      return fn(...args) as ReturnType<T>;
    } catch (error) {
      // Handle errors thrown during execution
      const originalError = error instanceof Error
        ? error
        : new Error(String(error));

      // Check for security violations
      if (originalError instanceof SandboxSecurityError) {
        // Security errors should propagate without modification
        throw originalError;
      }

      // Map the error location (placeholder for PR 2.2)
      const sourceLocation = mapErrorLocation(originalError, options);

      // Create an enhanced error
      const enhancedError = new PatternExecutionError(
        originalError.message,
        patternId,
        originalError,
        functionName,
        sourceLocation,
      );

      // Include original stack in debug mode
      if (debug && originalError.stack) {
        enhancedError.stack = originalError.stack;
      }

      throw enhancedError;
    }
  }) as WrappedFunction<T>;
}

/**
 * Wrap an async function with execution context.
 *
 * @param fn - The async function to wrap
 * @param options - Wrapper options
 * @returns The wrapped async function
 */
// deno-lint-ignore no-explicit-any
export function wrapAsyncExecution<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  options: ExecutionWrapperOptions,
): WrappedFunction<T> {
  const { patternId, functionName, debug } = options;

  return (async (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => {
    try {
      return await fn(...args) as Awaited<ReturnType<T>>;
    } catch (error) {
      const originalError = error instanceof Error
        ? error
        : new Error(String(error));

      if (originalError instanceof SandboxSecurityError) {
        throw originalError;
      }

      const sourceLocation = mapErrorLocation(originalError, options);

      const enhancedError = new PatternExecutionError(
        originalError.message,
        patternId,
        originalError,
        functionName,
        sourceLocation,
      );

      if (debug && originalError.stack) {
        enhancedError.stack = originalError.stack;
      }

      throw enhancedError;
    }
  }) as unknown as WrappedFunction<T>;
}

/**
 * Map an error to its original source location.
 *
 * Parses the error stack trace, classifies frames, and extracts
 * the first pattern frame's location.
 *
 * @param error - The error to map
 * @param _options - Execution options (for future source map support)
 * @returns The source location, or undefined if not mappable
 */
function mapErrorLocation(
  error: Error,
  _options: ExecutionWrapperOptions,
): SourceLocation | undefined {
  // Import lazily to avoid circular dependencies
  // The full error mapper with source map support can be used here
  // when source maps are available in the execution context

  if (!error.stack) {
    return undefined;
  }

  // Parse the stack trace to find the first pattern frame
  // This is a simplified version - the full ErrorMapper can be used
  // when source maps are loaded
  const lines = error.stack.split("\n");
  for (const line of lines) {
    // Skip non-frame lines
    if (!line.includes("at ")) continue;

    // Skip internal frames
    if (
      line.includes("/runner/") ||
      line.includes("/harness/") ||
      line.includes("AMDLoader") ||
      line.includes("<CT_INTERNAL>") ||
      line.includes("/ses/") ||
      line.includes("Compartment")
    ) {
      continue;
    }

    // Try to parse the frame
    const match = line.match(
      /at\s+(?:[\w.$<>[\]]+\s+)?\(?(.*?):(\d+):(\d+)\)?$/,
    );
    if (match) {
      const [, file, lineStr, columnStr] = match;
      return {
        file,
        line: parseInt(lineStr, 10),
        column: parseInt(columnStr, 10),
      };
    }
  }

  return undefined;
}

/**
 * Check if an error is a pattern execution error.
 */
export function isPatternExecutionError(
  error: unknown,
): error is PatternExecutionError {
  return error instanceof PatternExecutionError;
}

/**
 * Extract a user-friendly message from any error.
 */
export function getErrorMessage(error: unknown, patternId?: string): string {
  if (error instanceof PatternExecutionError) {
    return error.toUserMessage();
  }

  if (error instanceof SandboxSecurityError) {
    return `Security error${
      error.patternId ? ` in pattern "${error.patternId}"` : ""
    }: ${error.message}`;
  }

  if (error instanceof Error) {
    const prefix = patternId ? `Error in pattern "${patternId}": ` : "";
    return `${prefix}${error.message}`;
  }

  return String(error);
}
