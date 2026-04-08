import { assertEquals } from "@std/assert";
import { CFC_CANONICAL_ALIAS_NAMES } from "../src/cfc-authoring.ts";

Deno.test("ts-transformers re-exports the canonical CFC alias set", () => {
  assertEquals(CFC_CANONICAL_ALIAS_NAMES, [
    "Cfc",
    "Classified",
    "Integrity",
    "AddIntegrity",
    "RequiresIntegrity",
    "MaxConfidentiality",
    "OpaqueInput",
    "WriteAuthorizedBy",
    "ExactCopy",
    "ProjectionPath",
    "ProjectionOf",
    "Projection",
    "LengthPreservedFrom",
    "FilteredFrom",
    "SubsetOf",
    "PermutationOf",
  ]);
});
