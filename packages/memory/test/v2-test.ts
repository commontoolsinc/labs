import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  DEFAULT_BRANCH,
  isSourceLink,
  MEMORY_V2_PROTOCOL,
  normalizeEntityDocument,
  toDocumentPath,
  toEntityDocument,
  toSourceLink,
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
      $ctDocument: "common-tools/document@1",
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

Deno.test("memory v2 normalizes legacy document envelopes", () => {
  assertEquals(
    normalizeEntityDocument({
      value: { hello: "world" },
    }),
    {
      $ctDocument: "common-tools/document@1",
      value: { hello: "world" },
    },
  );
});
