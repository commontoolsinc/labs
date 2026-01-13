/**
 * Search functionality for ct doc command.
 *
 * Uses MiniSearch for semantic search when the pre-built index is available,
 * falls back to grep-like text search otherwise.
 */

import { dirname, fromFileUrl, join } from "@std/path";
import MiniSearch from "npm:minisearch@7";
import { loadDocIndex, readDocContent } from "./index.ts";
import type { ContextOptions, SearchMatch, SearchResult } from "./types.ts";

// Path to bundled search index
const SEARCH_INDEX_PATH = join(
  dirname(fromFileUrl(import.meta.url)),
  "..",
  "..",
  "..",
  "static",
  "assets",
  "docs",
  "search-index.json"
);

let miniSearchInstance: MiniSearch | null = null;

/**
 * Load or build the MiniSearch instance.
 */
async function getMiniSearch(): Promise<MiniSearch | null> {
  if (miniSearchInstance) {
    return miniSearchInstance;
  }

  // Try to load pre-built index
  try {
    const serialized = await Deno.readTextFile(SEARCH_INDEX_PATH);
    miniSearchInstance = MiniSearch.loadJSON(serialized, {
      fields: ["title", "content", "codeBlocks", "headings"],
      storeFields: ["title", "path"],
    });
    return miniSearchInstance;
  } catch {
    // No pre-built index available
    return null;
  }
}

/**
 * Search docs using MiniSearch (semantic) or grep (fallback).
 */
export async function searchDocs(
  query: string,
  options: ContextOptions = { before: 2, after: 2 }
): Promise<SearchResult[]> {
  const ms = await getMiniSearch();

  if (ms) {
    // Use MiniSearch for ranked results
    const results = ms.search(query, {
      boost: { title: 3, headings: 2, codeBlocks: 1.5, content: 1 },
      fuzzy: 0.2,
      prefix: true,
    });

    // Enhance results with context
    const enhancedResults: SearchResult[] = [];
    for (const result of results.slice(0, 20)) {
      const content = await readDocContent(result.path);
      const matches = findMatchesWithContext(content, query, options);

      enhancedResults.push({
        path: result.path,
        title: result.title,
        score: result.score,
        matches,
      });
    }

    return enhancedResults;
  }

  // Fallback: grep-like search through all docs
  return await grepSearch(query, options);
}

/**
 * Search for docs similar to a code snippet.
 */
export async function searchSimilar(
  code: string,
  options: ContextOptions = { before: 2, after: 2 }
): Promise<SearchResult[]> {
  // Extract meaningful terms from the code
  const terms = extractCodeTerms(code);

  if (terms.length === 0) {
    return [];
  }

  const ms = await getMiniSearch();

  if (ms) {
    // Use MiniSearch with extracted terms, boost code blocks
    const results = ms.search(terms.join(" "), {
      boost: { codeBlocks: 3, title: 2, headings: 1.5, content: 1 },
      fuzzy: 0.2,
      prefix: true,
    });

    const enhancedResults: SearchResult[] = [];
    for (const result of results.slice(0, 10)) {
      const content = await readDocContent(result.path);
      // Find matches for any of the terms
      const matches = findMatchesWithContext(
        content,
        terms.join("|"),
        options,
        true // use regex
      );

      enhancedResults.push({
        path: result.path,
        title: result.title,
        score: result.score,
        matches,
      });
    }

    return enhancedResults;
  }

  // Fallback: search for each term
  return await grepSearch(terms.join("|"), options, true);
}

/**
 * Extract meaningful terms from code for similarity search.
 */
function extractCodeTerms(code: string): string[] {
  const terms = new Set<string>();

  // Extract identifiers (camelCase, PascalCase, snake_case)
  const identifierRegex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
  let match;
  while ((match = identifierRegex.exec(code)) !== null) {
    const term = match[0];
    // Skip common keywords and short terms
    if (term.length > 2 && !isCommonKeyword(term)) {
      terms.add(term.toLowerCase());
    }
  }

  // Extract type names (typically PascalCase)
  const typeRegex = /\b[A-Z][a-zA-Z0-9]*\b/g;
  while ((match = typeRegex.exec(code)) !== null) {
    terms.add(match[0].toLowerCase());
  }

  // Look for common pattern terms
  const patternTerms = [
    "Cell",
    "computed",
    "lift",
    "handler",
    "pattern",
    "UI",
    "NAME",
    "ID",
    "Default",
    "Writable",
    "Stream",
  ];
  for (const term of patternTerms) {
    if (code.includes(term)) {
      terms.add(term.toLowerCase());
    }
  }

  return Array.from(terms);
}

/**
 * Check if a term is a common programming keyword.
 */
function isCommonKeyword(term: string): boolean {
  const keywords = new Set([
    "const",
    "let",
    "var",
    "function",
    "return",
    "if",
    "else",
    "for",
    "while",
    "import",
    "export",
    "from",
    "default",
    "class",
    "interface",
    "type",
    "extends",
    "implements",
    "new",
    "this",
    "true",
    "false",
    "null",
    "undefined",
    "async",
    "await",
    "try",
    "catch",
    "throw",
    "typeof",
    "instanceof",
    "void",
    "any",
    "string",
    "number",
    "boolean",
    "object",
    "array",
  ]);
  return keywords.has(term.toLowerCase());
}

/**
 * Grep-like fallback search.
 */
async function grepSearch(
  pattern: string,
  options: ContextOptions,
  isRegex = false
): Promise<SearchResult[]> {
  const index = await loadDocIndex();
  const results: SearchResult[] = [];

  for (const doc of index.docs) {
    try {
      const content = await readDocContent(doc.path);
      const matches = findMatchesWithContext(content, pattern, options, isRegex);

      if (matches.length > 0) {
        results.push({
          path: doc.path,
          title: doc.title,
          score: matches.length, // Simple scoring by match count
          matches,
        });
      }
    } catch {
      // Skip files that can't be read
    }
  }

  // Sort by match count
  results.sort((a, b) => b.score - a.score);

  return results;
}

/**
 * Find all matches in content with surrounding context.
 */
function findMatchesWithContext(
  content: string,
  pattern: string,
  options: ContextOptions,
  isRegex = false
): SearchMatch[] {
  const lines = content.split("\n");
  const matches: SearchMatch[] = [];

  let regex: RegExp;
  try {
    regex = isRegex
      ? new RegExp(pattern, "gi")
      : new RegExp(escapeRegex(pattern), "gi");
  } catch {
    // Invalid regex, treat as literal
    regex = new RegExp(escapeRegex(pattern), "gi");
  }

  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      // Reset regex lastIndex for next test
      regex.lastIndex = 0;

      const beforeStart = Math.max(0, i - options.before);
      const afterEnd = Math.min(lines.length - 1, i + options.after);

      matches.push({
        line: i + 1, // 1-indexed
        content: lines[i],
        context: {
          before: lines.slice(beforeStart, i),
          after: lines.slice(i + 1, afterEnd + 1),
        },
      });
    }
  }

  return matches;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Format search results for display.
 */
export function formatSearchResults(
  results: SearchResult[],
  showContext = true
): string {
  if (results.length === 0) {
    return "No matches found.";
  }

  const lines: string[] = [];

  for (const result of results) {
    lines.push(`\n${result.path} (${result.title})`);
    lines.push("─".repeat(Math.min(60, result.path.length + result.title.length + 3)));

    if (showContext && result.matches.length > 0) {
      for (const match of result.matches.slice(0, 3)) {
        // Show context before
        for (const ctxLine of match.context.before) {
          lines.push(`  ${ctxLine}`);
        }
        // Highlight the matching line
        lines.push(`> ${match.line}: ${match.content}`);
        // Show context after
        for (const ctxLine of match.context.after) {
          lines.push(`  ${ctxLine}`);
        }
        lines.push("");
      }

      if (result.matches.length > 3) {
        lines.push(`  ... and ${result.matches.length - 3} more matches`);
      }
    }
  }

  return lines.join("\n");
}
