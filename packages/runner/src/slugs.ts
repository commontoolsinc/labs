import type { MemorySpace } from "@commonfabric/memory/interface";
import { hashOf } from "@commonfabric/data-model/value-hash";

export interface SlugCause {
  space: MemorySpace;
  slug: string;
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 80;

export function isSlugAddress(value: string): boolean {
  return !value.includes(":");
}

/**
 * Whether a token is a slug, without throwing to say no.
 *
 * `validateSlug` reports *why* a slug is invalid, which suits a caller that
 * was handed one and has to explain itself. A caller deciding whether an
 * arbitrary path segment is a slug at all is asking a question, and a question
 * deserves an answer.
 */
export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= MAX_SLUG_LENGTH &&
    SLUG_PATTERN.test(slug);
}

export function validateSlug(slug: string): string {
  if (slug.length === 0) {
    throw new Error("Slug must not be empty.");
  }
  if (slug.includes("/")) {
    throw new Error("Slug must not contain '/'.");
  }
  if (slug.includes(":")) {
    throw new Error("Slug must not contain ':'.");
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new Error(`Slug must be at most ${MAX_SLUG_LENGTH} characters.`);
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      "Slug must use lowercase letters, numbers, and single hyphens between words.",
    );
  }
  return slug;
}

export function slugCause(space: MemorySpace, slug: string): SlugCause {
  return { space, slug: validateSlug(slug) };
}

export function slugIdForSpace(space: MemorySpace, slug: string): string {
  return hashOf({ causal: slugCause(space, slug) }).taggedHashString;
}
