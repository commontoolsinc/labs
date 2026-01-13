/**
 * Types for the ct doc command.
 */

/**
 * Metadata for a single documentation file.
 */
export interface DocEntry {
  id: string;
  path: string;
  title: string;
  headings: string[];
}

/**
 * The doc index structure stored in index.json.
 */
export interface DocIndex {
  version: number;
  generatedAt: string;
  docs: DocEntry[];
}

/**
 * A search result with context.
 */
export interface SearchResult {
  path: string;
  title: string;
  score: number;
  matches: SearchMatch[];
}

/**
 * A single match within a document.
 */
export interface SearchMatch {
  line: number;
  content: string;
  context: {
    before: string[];
    after: string[];
  };
}

/**
 * Options for search context display.
 */
export interface ContextOptions {
  before: number; // lines before match
  after: number;  // lines after match
}
