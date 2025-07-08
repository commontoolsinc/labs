/**
 * Path parsing utilities for CLI commands.
 * Standardizes on slash-notation path parsing for consistency.
 */

/**
 * Standardized path segment parsing - converts string segments to string/number values.
 * Handles numeric conversion consistently across all path parsing functions.
 * 
 * @param segments - Array of string segments to convert
 * @returns Array of string/number elements where numeric strings become numbers
 */
function parsePathSegments(segments: string[]): (string | number)[] {
  return segments.map((segment) => {
    if (!segment) return segment; // Preserve empty strings
    const num = Number(segment);
    return Number.isInteger(num) ? num : segment;
  });
}


/**
 * Converts a path string to an array of string/number elements.
 * Uses slash-notation as the standard path format.
 * 
 * @param path - Path string (e.g., "user/profile/name", "items/0/title")
 * @returns Array of string/number elements where numeric strings are converted to numbers
 * 
 * @example
 * parsePath("user/profile/name") // ["user", "profile", "name"]
 * parsePath("items/0/title") // ["items", 0, "title"]
 * parsePath("data/users/1/email") // ["data", "users", 1, "email"]
 */
export function parsePath(path: string): (string | number)[] {
  if (!path || path.trim() === "") {
    return [];
  }
  return parsePathSegments(path.split("/"));
}


