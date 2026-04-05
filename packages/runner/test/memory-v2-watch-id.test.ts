import { assertEquals, assertNotEquals } from "@std/assert";
import type {
  MIME,
  SchemaPathSelector,
  URI,
} from "@commonfabric/memory/interface";
import { watchIdForEntry } from "../src/storage/v2.ts";

Deno.test("memory v2 watch ids include branch in the stable key", () => {
  const address = {
    id: "of:watch-id-branch" as URI,
    type: "application/json" as MIME,
  };
  const selector: SchemaPathSelector = {
    path: [],
    schema: false,
  };

  assertEquals(
    watchIdForEntry(address, selector, "main"),
    watchIdForEntry(address, selector, "main"),
  );
  assertNotEquals(
    watchIdForEntry(address, selector, ""),
    watchIdForEntry(address, selector, "feature"),
  );
});
