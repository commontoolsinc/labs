import { toCompactDebugString } from "@/value-debug.ts";

/** Length a rendering is cut to. */
const MAX_LENGTH = 50;

/**
 * Renders `value` for an error message: its compact debug string, cut to a
 * length which keeps a large value from swamping the message it lands in, as
 * a backtick-quoted code span. `toCompactDebugString()` returns a fixed string
 * for what it cannot render, so this holds up on the failure path it serves.
 */
export function quotedDebugString(value: unknown): string {
  return toCompactDebugString(value, {
    maxLength: MAX_LENGTH,
    backtickQuote: true,
  });
}
