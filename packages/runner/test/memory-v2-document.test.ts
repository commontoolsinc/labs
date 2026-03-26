import { assertEquals, assertThrows } from "@std/assert";
import { toSourceLink, toWireEntityDocument } from "@commontools/memory/v2";
import type { StorageValue } from "../src/storage/interface.ts";
import {
  fromMemoryV2Document,
  toMemoryV2Document,
  toMemoryV2DocumentFromStorageValue,
} from "../src/storage/v2-document.ts";

Deno.test("memory v2 document conversion requires explicit full-document roots", () => {
  assertThrows(
    () => toMemoryV2Document(undefined),
    Error,
    "memory v2 transactions require explicit full-document roots",
  );
});

Deno.test(
  "memory v2 document conversion preserves source-only storage values",
  () => {
    const value = {
      value: undefined,
      source: { "/": "process:1" } as StorageValue["source"],
    } satisfies StorageValue;
    const document = toMemoryV2DocumentFromStorageValue(value);

    assertEquals(
      document,
      toWireEntityDocument(undefined, toSourceLink("process:1")),
    );
    assertEquals(fromMemoryV2Document(document), value);
  },
);
