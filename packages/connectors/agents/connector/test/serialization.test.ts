import { assertEquals, assertThrows } from "@std/assert";
import { canonicalJson } from "../src/canonical-json.ts";
import { chunkEvents } from "../src/chunking.ts";

Deno.test("canonical JSON sorts object keys inside arrays", () => {
  assertEquals(
    canonicalJson([{ z: 1, a: 2 }, "tail"]),
    '[{"a":2,"z":1},"tail"]',
  );
});

Deno.test("event chunking rejects invalid byte targets", () => {
  for (const targetBytes of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assertThrows(
      () => chunkEvents([], targetBytes),
      Error,
      "targetBytes must be a positive safe integer",
    );
  }
});
