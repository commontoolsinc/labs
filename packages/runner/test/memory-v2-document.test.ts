import { assertEquals } from "@std/assert";
import { toEntityDocument, toSourceLink } from "@commontools/memory/v2";
import type { StorageValue } from "../src/storage/interface.ts";
import {
  toMemoryV2Document,
  toMemoryV2DocumentFromStorageValue,
} from "../src/storage/v2-document.ts";

Deno.test("memory v2 document conversion tolerates undefined roots", () => {
  assertEquals(toMemoryV2Document(undefined), toEntityDocument(undefined));
});

Deno.test(
  "memory v2 document conversion preserves source-only storage values",
  () => {
    const document = toMemoryV2DocumentFromStorageValue({
      value: undefined,
      source: { "/": "process:1" } as StorageValue["source"],
    });

    assertEquals(
      document,
      toEntityDocument(undefined, toSourceLink("process:1")),
    );
  },
);
