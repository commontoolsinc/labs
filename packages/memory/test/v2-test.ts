import { afterEach, describe, it } from "@std/testing/bdd";
import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  resetDataModelConfig,
  setDataModelConfig,
} from "@commonfabric/data-model/fabric-value";
import {
  decodeMemoryBoundary,
  DEFAULT_BRANCH,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  isSourceLink,
  MEMORY_PROTOCOL,
  toDocumentPath,
  toDocumentSelector,
  toValuePath,
} from "../v2.ts";

const toSourceLink = (id: string) => ({ "/": id } as const);

const toEntityDocument = (
  value: unknown,
  source?: { "/": string },
  metadata: Record<string, unknown> = {},
) => {
  const document: Record<string, unknown> = {
    ...metadata,
    ...(source !== undefined ? { source } : {}),
  };
  if (value !== undefined) {
    document.value = value;
  }
  return document;
};

// ---------------------------------------------------------------------------
// Flag-independent tests (run once, not per-flag-state)
// ---------------------------------------------------------------------------

describe("memory v2 protocol constants", () => {
  it("exports the phase-1 protocol constants", () => {
    assertEquals(MEMORY_PROTOCOL, "memory");
    assertEquals(DEFAULT_BRANCH, "");
  });
});

describe("memory v2 documents", () => {
  it("builds explicit in-memory documents", () => {
    const source = toSourceLink("abc123");
    assertEquals(
      toEntityDocument({ hello: "world" }, source),
      {
        value: { hello: "world" },
        source,
      },
    );
  });

  it("builds explicit logical documents", () => {
    assertEquals(
      toEntityDocument({
        hello: "world",
      }),
      {
        value: { hello: "world" },
      },
    );
  });
});

describe("memory v2 paths", () => {
  it("document paths are explicit full-document paths", () => {
    assertEquals([...toDocumentPath([])], []);
    assertEquals(
      [...toDocumentPath(["value", "items", "0", "title"])],
      ["value", "items", "0", "title"],
    );
  });

  it("value-relative paths stay distinct from document paths", () => {
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
});

describe("memory v2 source links", () => {
  it("recognizes short source links", () => {
    assert(isSourceLink({ "/": "abc123" }));
    assertFalse(isSourceLink({ "/": { link: "abc123" } }));
    assertFalse(isSourceLink({}));
  });
});

// ---------------------------------------------------------------------------
// Flag-mechanism test (explicitly tests both OFF and ON in one test)
// ---------------------------------------------------------------------------

describe("memory v2 flags", () => {
  it("reflects the active runtime storage flags", () => {
    resetDataModelConfig();
    setDataModelConfig(false);

    assertEquals(getMemoryProtocolFlags(), {
      richStorableValues: false,
    });

    setDataModelConfig(true);

    assertEquals(getMemoryProtocolFlags(), {
      richStorableValues: true,
    });

    resetDataModelConfig();
  });
});

// ---------------------------------------------------------------------------
// Boundary encode/decode dispatch test (explicitly tests OFF and ON paths)
// ---------------------------------------------------------------------------

describe("memory v2 boundary decode", () => {
  afterEach(() => {
    resetDataModelConfig();
  });

  it("returns mutable plain JSON trees", () => {
    const decoded = decodeMemoryBoundary<{
      value: {
        nested: {
          count: number;
        };
      };
    }>(
      encodeMemoryBoundary({
        value: {
          nested: {
            count: 1,
          },
        },
      }),
    );

    assertEquals(decoded, {
      value: {
        nested: {
          count: 1,
        },
      },
    });
    assertFalse(Object.isFrozen(decoded));
    assertFalse(Object.isFrozen(decoded.value));
    assertFalse(Object.isFrozen(decoded.value.nested));

    decoded.value.nested.count = 2;
    assertEquals(decoded.value.nested.count, 2);
  });
});
