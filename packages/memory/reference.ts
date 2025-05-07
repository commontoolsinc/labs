import * as Reference from "npm:merkle-reference";
export * from "npm:merkle-reference";

// Don't know why deno does not seem to see there is a `fromString` so we just
// workaround it like this.
export const fromString = (Reference as any).fromString as (
  source: string,
) => Reference.Reference;
