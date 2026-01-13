/**
 * Search over bundled API type definitions.
 *
 * Provides grep-like search over commontools.d.ts and related type files.
 */

import { dirname, fromFileUrl, join } from "@std/path";
import type { ContextOptions, SearchMatch } from "./types.ts";

// Path to bundled type definitions
const TYPES_PATH = join(
  dirname(fromFileUrl(import.meta.url)),
  "..",
  "..",
  "..",
  "static",
  "assets",
  "types"
);

// Type files to search
const TYPE_FILES = [
  "commontools.d.ts",
  "jsx.d.ts",
];

export interface TypeSearchResult {
  file: string;
  matches: SearchMatch[];
}

/**
 * Search for a type name or pattern in the bundled type definitions.
 */
export async function searchTypes(
  pattern: string,
  options: ContextOptions = { before: 3, after: 3 }
): Promise<TypeSearchResult[]> {
  const results: TypeSearchResult[] = [];

  // Build regex - support common type search patterns
  let regex: RegExp;
  try {
    // If pattern looks like a type name, also match declarations
    if (/^[A-Z][a-zA-Z0-9]*$/.test(pattern)) {
      // Match type/interface/class declarations and usages
      regex = new RegExp(
        `\\b(type|interface|class|export)\\s+${pattern}\\b|\\b${pattern}\\b`,
        "gi"
      );
    } else {
      regex = new RegExp(pattern, "gi");
    }
  } catch {
    regex = new RegExp(escapeRegex(pattern), "gi");
  }

  for (const file of TYPE_FILES) {
    const filePath = join(TYPES_PATH, file);
    try {
      const content = await Deno.readTextFile(filePath);
      const matches = findMatchesWithContext(content, regex, options);

      if (matches.length > 0) {
        results.push({ file, matches });
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return results;
}

/**
 * Find all matches in content with surrounding context.
 */
function findMatchesWithContext(
  content: string,
  regex: RegExp,
  options: ContextOptions
): SearchMatch[] {
  const lines = content.split("\n");
  const matches: SearchMatch[] = [];
  const seenLines = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i]) && !seenLines.has(i)) {
      regex.lastIndex = 0;
      seenLines.add(i);

      const beforeStart = Math.max(0, i - options.before);
      const afterEnd = Math.min(lines.length - 1, i + options.after);

      matches.push({
        line: i + 1,
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
 * Escape special regex characters.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Format type search results for display.
 */
export function formatTypeResults(results: TypeSearchResult[]): string {
  if (results.length === 0) {
    return "No type definitions found.";
  }

  const lines: string[] = [];

  for (const result of results) {
    lines.push(`\n${result.file}`);
    lines.push("─".repeat(result.file.length));

    for (const match of result.matches) {
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
  }

  return lines.join("\n");
}
