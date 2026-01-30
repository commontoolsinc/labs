/**
 * Error display formatting for sandboxed pattern execution.
 *
 * This module provides functions to format errors for display to users,
 * with different verbosity levels for pattern authors vs runtime developers.
 */

import type { ClassifiedFrame } from "./frame-classifier.ts";
import type { MappedError } from "./error-mapping.ts";

/**
 * Display options for error formatting.
 */
export interface ErrorDisplayOptions {
  /**
   * Whether to show full stack traces (debug mode).
   * Default: false.
   */
  readonly verbose?: boolean;

  /**
   * Whether to use colors in output (for terminal display).
   * Default: false
   */
  readonly colors?: boolean;

  /**
   * Maximum number of frames to show.
   * Default: 10 in normal mode, unlimited in debug mode.
   */
  readonly maxFrames?: number;

  /**
   * Whether to show frame type annotations.
   * Default: false (true in debug mode)
   */
  readonly showFrameTypes?: boolean;
}

/**
 * ANSI color codes for terminal output.
 */
const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
} as const;

/**
 * Format a mapped error for display.
 *
 * @param mappedError - The mapped error to format
 * @param options - Display options
 * @returns Formatted error string
 */
export function formatError(
  mappedError: MappedError,
  options: ErrorDisplayOptions = {},
): string {
  const verbose = options.verbose ?? false;
  const colors = options.colors ?? false;
  const maxFrames = options.maxFrames ?? (verbose ? Infinity : 10);
  const showFrameTypes = options.showFrameTypes ?? verbose;

  const parts: string[] = [];

  // Error header
  const errorName = mappedError.originalError.name || "Error";
  if (colors) {
    parts.push(
      `${COLORS.bold}${COLORS.red}${errorName}${COLORS.reset}: ${mappedError.originalError.message}`,
    );
  } else {
    parts.push(`${errorName}: ${mappedError.originalError.message}`);
  }

  // Stack frames
  const frames = mappedError.frames.slice(0, maxFrames);
  for (const frame of frames) {
    parts.push(formatFrame(frame, { colors, showFrameTypes }));
  }

  // Truncation notice
  if (mappedError.frames.length > maxFrames) {
    const remaining = mappedError.frames.length - maxFrames;
    if (colors) {
      parts.push(
        `${COLORS.gray}    ... ${remaining} more frames${COLORS.reset}`,
      );
    } else {
      parts.push(`    ... ${remaining} more frames`);
    }
  }

  return parts.join("\n");
}

/**
 * Format a single stack frame.
 */
function formatFrame(
  frame: ClassifiedFrame,
  options: { colors?: boolean; showFrameTypes?: boolean },
): string {
  const { colors = false, showFrameTypes = false } = options;

  let line = frame.original;

  if (showFrameTypes) {
    const typeLabel = `[${frame.type}]`;
    if (colors) {
      const typeColor = getTypeColor(frame.type);
      line = `${line} ${typeColor}${typeLabel}${COLORS.reset}`;
    } else {
      line = `${line} ${typeLabel}`;
    }
  }

  if (colors) {
    // Color the frame based on its type
    switch (frame.type) {
      case "pattern":
        return `${COLORS.cyan}${line}${COLORS.reset}`;
      case "runtime":
      case "ses":
        return `${COLORS.gray}${line}${COLORS.reset}`;
      default:
        return line;
    }
  }

  return line;
}

/**
 * Get the color for a frame type.
 */
function getTypeColor(type: ClassifiedFrame["type"]): string {
  switch (type) {
    case "pattern":
      return COLORS.cyan;
    case "runtime":
      return COLORS.gray;
    case "ses":
      return COLORS.gray;
    case "external":
      return COLORS.yellow;
    default:
      return COLORS.reset;
  }
}

/**
 * Format an error for console output.
 *
 * This is a convenience function that uses sensible defaults for console.error().
 *
 * @param mappedError - The mapped error to format
 * @returns Formatted error string suitable for console output
 */
export function formatErrorForConsole(mappedError: MappedError): string {
  return formatError(mappedError, {
    verbose: false,
    colors: true,
    maxFrames: 5,
  });
}

/**
 * Format an error for logging.
 *
 * This includes more detail than console output but without colors.
 *
 * @param mappedError - The mapped error to format
 * @returns Formatted error string suitable for logging
 */
export function formatErrorForLog(mappedError: MappedError): string {
  return formatError(mappedError, {
    verbose: true,
    colors: false,
    showFrameTypes: true,
  });
}

/**
 * Format a user-friendly error message.
 *
 * This is a short, single-line message suitable for UI display.
 *
 * @param mappedError - The mapped error
 * @returns A concise error message
 */
export function formatUserMessage(mappedError: MappedError): string {
  return mappedError.userMessage;
}

/**
 * Create a structured error report suitable for error reporting services.
 */
export interface ErrorReport {
  /**
   * The error message.
   */
  readonly message: string;

  /**
   * The error name/type.
   */
  readonly name: string;

  /**
   * The pattern ID (if available).
   */
  readonly patternId?: string;

  /**
   * The source location (if mapped).
   */
  readonly location?: {
    readonly file: string;
    readonly line: number;
    readonly column: number;
  };

  /**
   * The full mapped stack trace.
   */
  readonly stack: string;

  /**
   * Frame classification summary.
   */
  readonly frameSummary: {
    readonly total: number;
    readonly pattern: number;
    readonly runtime: number;
    readonly external: number;
    readonly ses: number;
  };
}

/**
 * Create a structured error report from a mapped error.
 *
 * @param mappedError - The mapped error
 * @param patternId - Optional pattern ID
 * @returns A structured error report
 */
export function createErrorReport(
  mappedError: MappedError,
  patternId?: string,
): ErrorReport {
  const frames = mappedError.frames;
  const frameSummary = {
    total: frames.length,
    pattern: frames.filter((f) => f.type === "pattern").length,
    runtime: frames.filter((f) => f.type === "runtime").length,
    external: frames.filter((f) => f.type === "external").length,
    ses: frames.filter((f) => f.type === "ses").length,
  };

  return {
    message: mappedError.originalError.message,
    name: mappedError.originalError.name || "Error",
    patternId,
    location: mappedError.patternLocation,
    stack: mappedError.mappedStack,
    frameSummary,
  };
}
