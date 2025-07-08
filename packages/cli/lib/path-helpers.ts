/**
 * Path parsing utilities for cell manipulation commands.
 * Provides pure utility functions for converting dot-notation paths to PropertyKey arrays.
 */

/**
 * Converts a dot-notation path string to an array of PropertyKey elements.
 * 
 * @param path - Dot-notation path string (e.g., "user.profile.name", "items.0.title")
 * @returns Array of PropertyKey elements where numeric strings are converted to numbers
 * 
 * @example
 * parseDotNotationPath("user.profile.name") // ["user", "profile", "name"]
 * parseDotNotationPath("items.0.title") // ["items", 0, "title"]
 * parseDotNotationPath("data.users.1.email") // ["data", "users", 1, "email"]
 */
export function parseDotNotationPath(path: string): PropertyKey[] {
  if (!path || path.trim() === "") {
    return [];
  }

  return path.split(".").map((segment) => {
    // Check if segment is a valid number (array index)
    const numericValue = parseInt(segment, 10);
    return !isNaN(numericValue) && numericValue.toString() === segment
      ? numericValue
      : segment;
  });
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