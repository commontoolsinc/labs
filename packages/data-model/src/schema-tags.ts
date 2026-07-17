/**
 * Discovery-tag utilities for JSONSchema values.
 *
 * This module is a dependency-free leaf (only the `JSONSchema` type) so that
 * the schema generator — which type-checks its import graph under stricter
 * compiler options — and client-side consumers can share the tag definition
 * with the runtime.
 */

import type { JSONSchema } from "@commonfabric/api";

// A hashtag is `#` followed by a run of Unicode letters, combining marks,
// numbers, and underscores. This matches the convention shared across social
// platforms: letters from any script are accepted (Latin with diacritics, CJK,
// Cyrillic, Arabic, and so on), not just unaccented a-z. Any other character,
// including a hyphen, whitespace, or the end of the text, terminates the tag.
const HASHTAG_PATTERN = /#([\p{L}\p{M}\p{N}_]+)/gu;

/**
 * Extract hashtag tokens from free text. A token starts at `#` and runs through
 * Unicode letters, combining marks, numbers, and underscores; a hyphen, space,
 * or other punctuation ends it. Returns the tokens lowercased, without the
 * leading `#`, deduplicated, in order of first appearance.
 *
 * TODO(danfuzz): This function doesn't really have anything to do with the
 * data model and should probably move to the `utils` package.
 */
export function extractHashtags(text: string): string[] {
  const tags: string[] = [];
  for (const match of text.matchAll(HASHTAG_PATTERN)) {
    const tag = match[1]!.toLowerCase();
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/**
 * Schema keywords whose values are themselves schemas (or collections of
 * schemas). Used to walk the schema tree without descending into data
 * positions such as `default` or `examples`.
 */
const SCHEMA_CHILD_KEYWORDS = [
  "properties",
  "additionalProperties",
  "items",
  "anyOf",
  "allOf",
  "oneOf",
  "not",
  "contentSchema",
  "$defs",
  "definitions",
] as const;

const RECORD_VALUED_KEYWORDS = new Set<string>([
  "properties",
  "$defs",
  "definitions",
]);

/**
 * Collect the discovery tags of a schema.
 *
 * Reads the structured `tags` fields emitted by the schema generator,
 * aggregated across the schema tree (root and nested schemas), lowercased
 * and deduplicated.
 */
export function tagsFromSchema(
  schema: JSONSchema | undefined | null,
): string[] {
  if (schema === null || typeof schema !== "object") return [];

  const tags: string[] = [];
  const visited = new Set<object>();

  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);

    const record = node as Record<string, unknown>;
    if (Array.isArray(record.tags)) {
      for (const tag of record.tags) {
        if (typeof tag !== "string") continue;
        const lowered = tag.toLowerCase();
        if (!tags.includes(lowered)) tags.push(lowered);
      }
    }

    for (const keyword of SCHEMA_CHILD_KEYWORDS) {
      const child = record[keyword];
      if (child === null || typeof child !== "object") continue;
      if (Array.isArray(child)) {
        for (const entry of child) visit(entry);
      } else if (RECORD_VALUED_KEYWORDS.has(keyword)) {
        for (const value of Object.values(child)) visit(value);
      } else {
        visit(child);
      }
    }
  };

  visit(schema);
  return tags;
}
