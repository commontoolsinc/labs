/**
 * Represents a namespace for entity IDs
 */
export interface Space {
  /** URI identifying the space */
  uri: string;
}

// Map to ensure we return the same Space object for the same URI
const spaceCache = new Map<string, Space>();

/**
 * Creates or retrieves a Space object for the given URI
 */
export function getSpace(uri: string): Space {
  let space = spaceCache.get(uri);
  if (!space) {
    space = { uri };
    spaceCache.set(uri, space);
  }
  return space;
}
