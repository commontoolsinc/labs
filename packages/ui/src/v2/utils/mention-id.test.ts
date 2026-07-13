import { assertEquals, assertThrows } from "@std/assert";
import { mentionIdFromCellId } from "./mention-id.ts";

Deno.test("mentionIdFromCellId strips of: and passes bare ids through", () => {
  assertEquals(mentionIdFromCellId("of:fid1:abc"), "fid1:abc");
  assertEquals(mentionIdFromCellId("fid1:abc"), "fid1:abc");
});

Deno.test("mentionIdFromCellId rejects computed: ids", () => {
  // The scheme is part of the identity; stripping it would silently embed
  // the of: sibling into persisted note content.
  assertThrows(
    () => mentionIdFromCellId("computed:fid1:abc"),
    Error,
    "computed:",
  );
});
