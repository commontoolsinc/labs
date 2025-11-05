import { assertEquals } from "@std/assert";

import {
  isSafeIdentifierText,
  sanitizeIdentifierCandidate,
} from "../../src/utils/identifiers.ts";

Deno.test("sanitizeIdentifierCandidate normalises invalid fallback prefixes", () => {
  const result = sanitizeIdentifierCandidate("", { fallback: "-ref" });
  assertEquals(result, "_ref");
});

Deno.test("isSafeIdentifierText recognises astral plane characters", () => {
  assertEquals(isSafeIdentifierText("𠮷"), true);
});
