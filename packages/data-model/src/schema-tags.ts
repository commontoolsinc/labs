/**
 * Discovery-tag extraction for schema doc text.
 *
 * This module is a dependency-free leaf so that the schema generator (which
 * type-checks its import graph under stricter compiler options) can share
 * the hashtag definition with runtime consumers.
 */

const HASHTAG_PATTERN = /#([a-z0-9-]+)/gi;

/**
 * Extract hashtag tokens from free text. Returns the tokens lowercased,
 * without the leading `#`, deduplicated, in order of first appearance.
 */
export function extractHashtags(text: string): string[] {
  const tags: string[] = [];
  for (const match of text.matchAll(HASHTAG_PATTERN)) {
    const tag = match[1]!.toLowerCase();
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}
