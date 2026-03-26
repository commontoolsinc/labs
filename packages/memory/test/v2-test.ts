import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  DEFAULT_BRANCH,
  isSourceLink,
  MEMORY_V2_PROTOCOL,
  toDocumentPath,
  toDocumentSelector,
  toEntityDocument,
  toSourceLink,
  toValuePath,
  toWireEntityDocument,
} from "../v2.ts";

Deno.test("memory v2 exports the phase-1 protocol constants", () => {
  assertEquals(MEMORY_V2_PROTOCOL, "memory/v2");
  assertEquals(DEFAULT_BRANCH, "");
});

Deno.test("memory v2 builds explicit in-memory documents", () => {
  const source = toSourceLink("abc123");
  assertEquals(
    toEntityDocument({ hello: "world" }, source),
    {
      value: { hello: "world" },
      source,
    },
  );
});

Deno.test("memory v2 document paths are explicit full-document paths", () => {
  assertEquals(toDocumentPath([]), toDocumentPath([]));
  assertEquals(
    toDocumentPath(["value", "items", "0", "title"]),
    toDocumentPath(["value", "items", "0", "title"]),
  );
});

Deno.test("memory v2 value-relative paths stay distinct from document paths", () => {
  assertEquals(toValuePath([]), toValuePath([]));
  assertEquals(
    toDocumentSelector({
      path: toValuePath(["items", "0"]),
      schema: false,
    }),
    {
      path: toDocumentPath(["value", "items", "0"]),
      schema: false,
    },
  );
});

Deno.test("memory v2 recognizes short source links", () => {
  assert(isSourceLink({ "/": "abc123" }));
  assertFalse(isSourceLink({ "/": { link: "abc123" } }));
  assertFalse(isSourceLink({}));
});

Deno.test("memory v2 builds explicit wire documents", () => {
  assertEquals(
    toWireEntityDocument({
      hello: "world",
    }),
    {
      value: { hello: "world" },
    },
  );
});
