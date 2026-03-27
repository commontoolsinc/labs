import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  resetJsonEncodingConfig,
  setJsonEncodingConfig,
} from "@commontools/data-model/json-encoding";
import {
  resetSchemaHashConfig,
  setSchemaHashConfig,
} from "@commontools/data-model/schema-hash";
import {
  resetModernHashConfig,
  setModernHashConfig,
} from "@commontools/data-model/value-hash";
import {
  resetStorableValueConfig,
  setStorableValueConfig,
} from "../storable-value.ts";
import {
  decodeMemoryV2Boundary,
  DEFAULT_BRANCH,
  encodeMemoryV2Boundary,
  getMemoryV2Flags,
  isSourceLink,
  MEMORY_V2_PROTOCOL,
  toDocumentPath,
  toDocumentSelector,
  toEntityDocument,
  toSourceLink,
  toValuePath,
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
  assertEquals([...toDocumentPath([])], []);
  assertEquals(
    [...toDocumentPath(["value", "items", "0", "title"])],
    ["value", "items", "0", "title"],
  );
});

Deno.test("memory v2 value-relative paths stay distinct from document paths", () => {
  assertEquals([...toValuePath([])], []);
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

Deno.test("memory v2 builds explicit logical documents", () => {
  assertEquals(
    toEntityDocument({
      hello: "world",
    }),
    {
      value: { hello: "world" },
    },
  );
});

Deno.test("memory v2 reflects the active runtime storage flags", () => {
  resetStorableValueConfig();
  resetJsonEncodingConfig();
  resetModernHashConfig();
  resetSchemaHashConfig();

  assertEquals(getMemoryV2Flags(), {
    richStorableValues: false,
    unifiedJsonEncoding: false,
    canonicalHashing: false,
    modernSchemaHash: false,
  });

  setStorableValueConfig({ richStorableValues: true });
  setJsonEncodingConfig(true);
  setModernHashConfig(true);
  setSchemaHashConfig(true);

  assertEquals(getMemoryV2Flags(), {
    richStorableValues: true,
    unifiedJsonEncoding: true,
    canonicalHashing: true,
    modernSchemaHash: true,
  });

  resetStorableValueConfig();
  resetJsonEncodingConfig();
  resetModernHashConfig();
  resetSchemaHashConfig();
});

Deno.test("memory v2 boundary encoding follows unified JSON dispatch", () => {
  const document = {
    value: {
      present: 1,
      missing: undefined,
    },
  };

  resetJsonEncodingConfig();
  const legacyEncoded = encodeMemoryV2Boundary(document);
  assertEquals(legacyEncoded, JSON.stringify({ value: { present: 1 } }));
  assertEquals(decodeMemoryV2Boundary(legacyEncoded), {
    value: { present: 1 },
  });

  setJsonEncodingConfig(true);
  const unifiedEncoded = encodeMemoryV2Boundary(document);
  assertEquals(
    decodeMemoryV2Boundary(unifiedEncoded),
    document,
  );

  resetJsonEncodingConfig();
});
