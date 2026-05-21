import type { MemorySpace } from "@commonfabric/memory/interface";
import { hashOf } from "@commonfabric/data-model/value-hash";

export interface SlugCause {
  space: MemorySpace;
  slug: string;
}

export function isSlugAddress(value: string): boolean {
  return !value.includes(":");
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
  return slug;
}

export function slugCause(space: MemorySpace, slug: string): SlugCause {
  return { space, slug: validateSlug(slug) };
}

export function slugIdForSpace(space: MemorySpace, slug: string): string {
  const id = hashOf({ causal: slugCause(space, slug) }).toJSON?.()["/"];
  if (typeof id !== "string") {
    throw new Error("Could not derive slug id.");
  }
  return id;
}
