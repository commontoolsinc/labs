import { assertThrows } from "@std/assert";
import { toEntityDocumentFromTransactionValue } from "../src/storage/v2-document.ts";

Deno.test("memory v2 document conversion requires explicit full-document roots", () => {
  assertThrows(
    () => toEntityDocumentFromTransactionValue(undefined as never),
    Error,
    "memory v2 transactions require explicit full-document roots",
  );
});
