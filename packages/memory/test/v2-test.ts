import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  DEFAULT_BRANCH,
  MEMORY_V2_PROTOCOL,
  toDocumentPath,
  toEntityDocument,
  toSourceLink,
  isSourceLink,
} from "../v2.ts";

Deno.test("memory v2 exports the phase-1 protocol constants", () => {
  assertEquals(MEMORY_V2_PROTOCOL, "memory/v2");
  assertEquals(DEFAULT_BRANCH, "");
});

Deno.test("memory v2 wraps entity values in the expected document envelope", () => {
  const source = toSourceLink("abc123");
  assertEquals(
    toEntityDocument({ hello: "world" }, source),
    {
      value: { hello: "world" },
      source,
    },
  );
});

Deno.test("memory v2 re-roots query paths under the value field", () => {
  assertEquals(toDocumentPath([]), ["value"]);
  assertEquals(
    toDocumentPath(["items", "0", "title"]),
    ["value", "items", "0", "title"],
  );
});

Deno.test("memory v2 recognizes short source links", () => {
  assert(isSourceLink({ "/": "abc123" }));
  assertFalse(isSourceLink({ "/": { link: "abc123" } }));
  assertFalse(isSourceLink({}));
});
