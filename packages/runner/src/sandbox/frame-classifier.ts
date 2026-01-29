/**
 * Stack frame classification for error display.
 *
 * Classifies stack frames into categories to help pattern authors
 * understand where errors originated while hiding runtime internals.
 */

/**
 * Classification of a stack frame.
 */
export type FrameType = "pattern" | "runtime" | "external" | "ses";

/**
 * A parsed stack frame with classification.
 */
export interface ClassifiedFrame {
  /**
   * The original stack frame line.
   */
  readonly original: string;

  /**
   * The classification of this frame.
   */
  readonly type: FrameType;

  /**
   * The function name (if available).
   */
  readonly functionName?: string;

  /**
   * The file path or URL.
   */
  readonly file?: string;

  /**
   * The line number (1-based).
   */
  readonly line?: number;

  /**
   * The column number (0-based).
   */
  readonly column?: number;

  /**
   * Whether this frame has been mapped through source maps.
   */
  readonly isMapped: boolean;
}

/**
 * Patterns for identifying runtime internal frames.
 */
const RUNTIME_PATTERNS = [
  /\/runner\/src\//,
  /\/harness\//,
  /\/scheduler\//,
  /AMDLoader/,
  /<CT_INTERNAL>/,
  /\beval\b/,
];

/**
 * Patterns for identifying SES/Compartment frames.
 */
const SES_PATTERNS = [
  /\/ses\//,
  /Compartment/,
  /lockdown/,
  /harden/,
  /@endo\//,
];

/**
 * Patterns for identifying external library frames.
 */
const EXTERNAL_PATTERNS = [
  /node_modules/,
  /npm:/,
  /esm\.sh/,
  /deno\.land/,
  /jsr\.io/,
];

/**
 * Stack frame parsing pattern.
 * Matches formats like:
 * - "    at functionName (file.js:10:5)"
 * - "    at file.js:10:5"
 * - "    at Object.method [as alias] (file.js:10:5)"
 */
const FRAME_PATTERN =
  /^\s*at\s+(?:([\w.$<>[\]]+(?:\s+\[as\s+\w+\])?)\s+)?\(?(.*?):(\d+):(\d+)\)?$/;

/**
 * Classify a single stack frame.
 *
 * @param frameLine - The stack frame line to classify
 * @returns The classified frame
 */
export function classifyFrame(frameLine: string): ClassifiedFrame {
  const match = frameLine.match(FRAME_PATTERN);

  if (!match) {
    // Can't parse this frame, classify based on content
    return {
      original: frameLine,
      type: guessFrameType(frameLine),
      isMapped: false,
    };
  }

  const [, functionName, file, lineStr, columnStr] = match;
  const line = parseInt(lineStr, 10);
  const column = parseInt(columnStr, 10);

  // Determine frame type based on file path and function name
  const type = determineFrameType(file, functionName);

  return {
    original: frameLine,
    type,
    functionName: functionName || undefined,
    file,
    line,
    column,
    isMapped: frameLine.includes("<UNMAPPED>") ? false : true,
  };
}

/**
 * Classify all frames in a stack trace.
 *
 * @param stack - The full stack trace string
 * @returns Array of classified frames
 */
export function classifyStack(stack: string): ClassifiedFrame[] {
  const lines = stack.split("\n");
  const frames: ClassifiedFrame[] = [];

  for (const line of lines) {
    // Skip the error message line (first line usually)
    if (!line.trim().startsWith("at ") && !line.includes("    at ")) {
      continue;
    }

    frames.push(classifyFrame(line));
  }

  return frames;
}

/**
 * Determine the frame type based on file path and function name.
 */
function determineFrameType(
  file: string,
  functionName?: string,
): FrameType {
  const combined = `${file} ${functionName || ""}`;

  // Check for SES internals first
  for (const pattern of SES_PATTERNS) {
    if (pattern.test(combined)) {
      return "ses";
    }
  }

  // Check for runtime internals
  for (const pattern of RUNTIME_PATTERNS) {
    if (pattern.test(combined)) {
      return "runtime";
    }
  }

  // Check for external libraries
  for (const pattern of EXTERNAL_PATTERNS) {
    if (pattern.test(file)) {
      return "external";
    }
  }

  // Default to pattern code
  return "pattern";
}

/**
 * Guess frame type when we can't parse the frame.
 */
function guessFrameType(frameLine: string): FrameType {
  for (const pattern of SES_PATTERNS) {
    if (pattern.test(frameLine)) {
      return "ses";
    }
  }

  for (const pattern of RUNTIME_PATTERNS) {
    if (pattern.test(frameLine)) {
      return "runtime";
    }
  }

  for (const pattern of EXTERNAL_PATTERNS) {
    if (pattern.test(frameLine)) {
      return "external";
    }
  }

  return "pattern";
}

/**
 * Filter stack frames to only include relevant frames for pattern authors.
 *
 * In non-debug mode, this removes runtime and SES internals to provide
 * a cleaner error message focused on the pattern code.
 *
 * @param frames - The classified frames
 * @param includeAll - Whether to include all frames (debug mode)
 * @returns Filtered frames
 */
export function filterFrames(
  frames: readonly ClassifiedFrame[],
  includeAll: boolean = false,
): ClassifiedFrame[] {
  if (includeAll) {
    return [...frames];
  }

  // In non-debug mode, only show pattern and external frames
  // Keep the first runtime frame as context for where the pattern was called
  let foundPatternFrame = false;
  const filtered: ClassifiedFrame[] = [];

  for (const frame of frames) {
    if (frame.type === "pattern") {
      foundPatternFrame = true;
      filtered.push(frame);
    } else if (frame.type === "external") {
      // Include external frames (could be from libraries the pattern uses)
      filtered.push(frame);
    } else if (frame.type === "runtime" && !foundPatternFrame) {
      // Include runtime frames before the first pattern frame
      // This provides context for where the pattern was invoked
      filtered.push(frame);
    }
    // Skip SES frames and runtime frames after pattern frames
  }

  return filtered;
}

/**
 * Format classified frames back into a stack trace string.
 *
 * @param frames - The frames to format
 * @param verbose - Whether to include type annotations (for debugging)
 * @returns Formatted stack trace
 */
export function formatFrames(
  frames: readonly ClassifiedFrame[],
  verbose: boolean = false,
): string {
  return frames
    .map((frame) => {
      if (verbose) {
        return `${frame.original} [${frame.type}]`;
      }
      return frame.original;
    })
    .join("\n");
}
