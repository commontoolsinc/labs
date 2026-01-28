/**
 * Error mapping for sandboxed pattern execution.
 *
 * This module provides functionality to map error stack traces back to
 * original source locations using source maps, and to enhance errors
 * with pattern context information.
 */

import type { MappedPosition, SourceMap } from "@commontools/js-compiler";
import { SourceMapParser } from "@commontools/js-compiler";
import {
  type ClassifiedFrame,
  classifyStack,
  filterFrames,
  formatFrames,
} from "./frame-classifier.ts";
import { type SourceLocation } from "./execution-wrapper.ts";

/**
 * Options for error mapping.
 */
export interface ErrorMappingOptions {
  /**
   * Whether to include all frames (debug mode).
   * When false, runtime and SES internals are filtered out.
   */
  readonly debug?: boolean;

  /**
   * The pattern ID for error attribution.
   */
  readonly patternId?: string;

  /**
   * Optional source map for the pattern.
   */
  readonly sourceMap?: SourceMap;

  /**
   * The filename for source map lookups.
   */
  readonly filename?: string;
}

/**
 * Result of mapping an error.
 */
export interface MappedError {
  /**
   * The original error.
   */
  readonly originalError: Error;

  /**
   * The mapped stack trace (or original if no mapping possible).
   */
  readonly mappedStack: string;

  /**
   * Classified frames from the stack.
   */
  readonly frames: readonly ClassifiedFrame[];

  /**
   * The first pattern frame's source location (if found).
   */
  readonly patternLocation?: SourceLocation;

  /**
   * User-friendly error message.
   */
  readonly userMessage: string;
}

/**
 * ErrorMapper handles mapping error stack traces through source maps
 * and classifying frames for appropriate display.
 */
export class ErrorMapper {
  private readonly sourceMapParser = new SourceMapParser();
  private readonly debug: boolean;

  constructor(debug: boolean = false) {
    this.debug = debug;
  }

  /**
   * Load a source map for a pattern.
   *
   * @param filename - The compiled filename
   * @param sourceMap - The source map
   */
  loadSourceMap(filename: string, sourceMap: SourceMap): void {
    this.sourceMapParser.load(filename, sourceMap);
  }

  /**
   * Map an error through source maps and classify its frames.
   *
   * @param error - The error to map
   * @param options - Mapping options
   * @returns The mapped error information
   */
  mapError(error: Error, options: ErrorMappingOptions = {}): MappedError {
    const { debug = this.debug, patternId, sourceMap, filename } = options;

    // Load source map if provided
    if (filename && sourceMap) {
      this.loadSourceMap(filename, sourceMap);
    }

    // Get the stack trace
    const originalStack = error.stack || error.message;

    // Map through source maps
    const mappedStack = this.sourceMapParser.parse(originalStack);

    // Classify frames
    const allFrames = classifyStack(mappedStack);

    // Filter frames based on debug mode
    const filteredFrames = filterFrames(allFrames, debug);

    // Find the first pattern frame for location
    const patternFrame = allFrames.find((f) => f.type === "pattern");
    const patternLocation = patternFrame
      ? this.frameToLocation(patternFrame)
      : undefined;

    // Create user message
    const userMessage = this.createUserMessage(
      error,
      patternId,
      patternLocation,
    );

    return {
      originalError: error,
      mappedStack: formatFrames(filteredFrames, debug),
      frames: filteredFrames,
      patternLocation,
      userMessage,
    };
  }

  /**
   * Map a position through source maps.
   *
   * @param filename - The filename
   * @param line - The line number (1-based)
   * @param column - The column number (0-based)
   * @returns The mapped position, or null if not found
   */
  mapPosition(
    filename: string,
    line: number,
    column: number,
  ): MappedPosition | null {
    return this.sourceMapParser.mapPosition(filename, line, column);
  }

  /**
   * Parse a stack trace through source maps without classification.
   *
   * @param stack - The stack trace to parse
   * @returns The mapped stack trace
   */
  parseStack(stack: string): string {
    return this.sourceMapParser.parse(stack);
  }

  /**
   * Clear all loaded source maps.
   */
  clear(): void {
    this.sourceMapParser.clear();
  }

  /**
   * Convert a classified frame to a source location.
   */
  private frameToLocation(frame: ClassifiedFrame): SourceLocation | undefined {
    if (!frame.file || !frame.line) {
      return undefined;
    }

    return {
      file: frame.file,
      line: frame.line,
      column: frame.column ?? 0,
    };
  }

  /**
   * Create a user-friendly error message.
   */
  private createUserMessage(
    error: Error,
    patternId?: string,
    location?: SourceLocation,
  ): string {
    const parts: string[] = [];

    if (patternId) {
      parts.push(`Error in pattern "${patternId}"`);
    } else {
      parts.push("Error");
    }

    if (location) {
      parts.push(`at ${location.file}:${location.line}:${location.column}`);
    }

    parts.push(`: ${error.message}`);

    return parts.join(" ");
  }
}

/**
 * Create a new ErrorMapper instance.
 *
 * @param debug - Whether to enable debug mode
 * @returns A new ErrorMapper
 */
export function createErrorMapper(debug: boolean = false): ErrorMapper {
  return new ErrorMapper(debug);
}

/**
 * Quick helper to map an error without creating a persistent mapper.
 *
 * @param error - The error to map
 * @param options - Mapping options
 * @returns The mapped error information
 */
export function mapError(
  error: Error,
  options: ErrorMappingOptions = {},
): MappedError {
  const mapper = new ErrorMapper(options.debug);
  return mapper.mapError(error, options);
}
