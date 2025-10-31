import { assertEquals } from "@std/assert";

import { sanitizeIdentifierCandidate } from "../../src/utils/identifiers.ts";

Deno.test("sanitizeIdentifierCandidate normalises invalid fallback prefixes", () => {
  const result = sanitizeIdentifierCandidate("", { fallback: "-ref" });
  assertEquals(result, "_ref");
});
