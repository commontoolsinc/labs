import { afterEach, describe, it } from "@std/testing/bdd";
import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
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
  parseMemoryProtocolFlags,
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
      modernDataModel: false,
    });

    setDataModelConfig(true);

    assertEquals(getMemoryProtocolFlags(), {
      modernDataModel: true,
    });

    resetDataModelConfig();
  });
});

describe("parseMemoryProtocolFlags", () => {
  it("accepts the canonical modernDataModel key", () => {
    assertEquals(parseMemoryProtocolFlags({ modernDataModel: true }), {
      flags: { modernDataModel: true },
      wireKey: "modernDataModel",
    });
    assertEquals(parseMemoryProtocolFlags({ modernDataModel: false }), {
      flags: { modernDataModel: false },
      wireKey: "modernDataModel",
    });
  });

  it("accepts the legacy richStorableValues key and normalizes it", () => {
    assertEquals(parseMemoryProtocolFlags({ richStorableValues: true }), {
      flags: { modernDataModel: true },
      wireKey: "richStorableValues",
    });
    assertEquals(parseMemoryProtocolFlags({ richStorableValues: false }), {
      flags: { modernDataModel: false },
      wireKey: "richStorableValues",
    });
  });

  it("prefers the canonical key when both are present", () => {
    assertEquals(
      parseMemoryProtocolFlags({
        modernDataModel: true,
        richStorableValues: false,
      }),
      { flags: { modernDataModel: true }, wireKey: "modernDataModel" },
    );
  });

  it("rejects values that are not a recognizable flags shape", () => {
    assertEquals(parseMemoryProtocolFlags(null), null);
    assertEquals(parseMemoryProtocolFlags(undefined), null);
    assertEquals(parseMemoryProtocolFlags("modernDataModel"), null);
    assertEquals(parseMemoryProtocolFlags([true]), null);
    assertEquals(parseMemoryProtocolFlags({}), null);
    assertEquals(parseMemoryProtocolFlags({ modernDataModel: "true" }), null);
    assertEquals(
      parseMemoryProtocolFlags({ richStorableValues: 1 }),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// Boundary encode/decode dispatch test (explicitly tests OFF and ON paths)
// ---------------------------------------------------------------------------

describe("memory v2 boundary decode", () => {
  afterEach(() => {
    resetDataModelConfig();
  });

  it("returns deeply-frozen plain JSON trees", () => {
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
    assert(Object.isFrozen(decoded));
    assert(Object.isFrozen(decoded.value));
    assert(Object.isFrozen(decoded.value.nested));

    assertThrows(() => {
      decoded.value.nested.count = 2;
    }, TypeError);
    assertEquals(decoded.value.nested.count, 1);
  });
});
