/**
 * Path parsing utilities for CLI commands.
 * Provides unified path parsing for both dot-notation and slash-notation paths.
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
 * Converts a dot-notation path string to an array of string/number elements.
 * 
 * @param path - Dot-notation path string (e.g., "user.profile.name", "items.0.title")
 * @returns Array of string/number elements where numeric strings are converted to numbers
 * 
 * @example
 * parseDotNotationPath("user.profile.name") // ["user", "profile", "name"]
 * parseDotNotationPath("items.0.title") // ["items", 0, "title"]
 * parseDotNotationPath("data.users.1.email") // ["data", "users", 1, "email"]
 */
export function parseDotNotationPath(path: string): (string | number)[] {
  if (!path || path.trim() === "") {
    return [];
  }
  return parsePathSegments(path.split("."));
}

/**
 * Converts a slash-notation path string to an array of string/number elements.
 * 
 * @param path - Slash-notation path string (e.g., "user/profile/name", "items/0/title")
 * @returns Array of string/number elements where numeric strings are converted to numbers
 * 
 * @example
 * parseSlashNotationPath("user/profile/name") // ["user", "profile", "name"]
 * parseSlashNotationPath("items/0/title") // ["items", 0, "title"]
 * parseSlashNotationPath("data/users/1/email") // ["data", "users", 1, "email"]
 */
export function parseSlashNotationPath(path: string): (string | number)[] {
  if (!path || path.trim() === "") {
    return [];
  }
  return parsePathSegments(path.split("/"));
}

/**
 * Converts a PropertyKey array back to a dot-notation path string.
 * 
 * @param pathArray - Array of PropertyKey elements
 * @returns Dot-notation path string
 * 
 * @example
 * propertyKeyArrayToPath(["user", "profile", "name"]) // "user.profile.name"
 * propertyKeyArrayToPath(["items", 0, "title"]) // "items.0.title"
 */
export function propertyKeyArrayToPath(pathArray: PropertyKey[]): string {
  return pathArray.map((key) => key.toString()).join(".");
}

/**
 * Validates that a path string is a valid dot-notation path.
 * 
 * @param path - Path string to validate
 * @returns True if valid, false otherwise
 * 
 * @example
 * isValidDotNotationPath("user.profile.name") // true
 * isValidDotNotationPath("items.0.title") // true
 * isValidDotNotationPath("") // false
 * isValidDotNotationPath("..invalid") // false
 */
export function isValidDotNotationPath(path: string): boolean {
  if (!path || path.trim() === "") {
    return false;
  }

  // Check for invalid patterns
  if (path.startsWith(".") || path.endsWith(".") || path.includes("..")) {
    return false;
  }

  // All segments must be non-empty
  const segments = path.split(".");
  return segments.every((segment) => segment.trim() !== "");
}