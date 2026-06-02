import { afterEach, describe, it } from "@std/testing/bdd";
import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import {
  resetDataModelConfig,
  setDataModelConfig,
} from "@commonfabric/data-model/fabric-value";
import {
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import {
  compatibleMemoryProtocolFlags,
  decodeMemoryBoundary,
  DEFAULT_BRANCH,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  isSourceLink,
  MEMORY_PROTOCOL,
  parseMemoryProtocolFlags,
  resetPersistentSchedulerStateConfig,
  setPersistentSchedulerStateConfig,
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
    resetModernCellRepConfig();
    resetDataModelConfig();
    resetPersistentSchedulerStateConfig();
    setModernCellRepConfig(false);
    setDataModelConfig(false);
    setPersistentSchedulerStateConfig(false);

    assertEquals(getMemoryProtocolFlags(), {
      modernCellRep: false,
      modernDataModel: false,
      persistentSchedulerState: false,
    });

    setModernCellRepConfig(true);
    setDataModelConfig(true);
    setPersistentSchedulerStateConfig(true);

    assertEquals(getMemoryProtocolFlags(), {
      modernCellRep: true,
      modernDataModel: true,
      persistentSchedulerState: true,
    });

    resetModernCellRepConfig();
    resetDataModelConfig();
    resetPersistentSchedulerStateConfig();
  });

  it("treats scheduler-state persistence as an optional capability", () => {
    assert(compatibleMemoryProtocolFlags(
      {
        modernCellRep: true,
        modernDataModel: true,
        persistentSchedulerState: true,
      },
      {
        modernCellRep: true,
        modernDataModel: true,
        persistentSchedulerState: false,
      },
    ));
    assertFalse(compatibleMemoryProtocolFlags(
      {
        modernCellRep: true,
        modernDataModel: true,
        persistentSchedulerState: true,
      },
      {
        modernCellRep: true,
        modernDataModel: false,
        persistentSchedulerState: true,
      },
    ));
  });
});

describe("parseMemoryProtocolFlags", () => {
  it("accepts the modernCellRep key", () => {
    assertEquals(parseMemoryProtocolFlags({ modernCellRep: true }), {
      flags: {
        modernCellRep: true,
        modernDataModel: false,
        persistentSchedulerState: false,
      },
      wireKey: "modernDataModel",
    });
    assertEquals(parseMemoryProtocolFlags({ modernCellRep: false }), {
      flags: {
        modernCellRep: false,
        modernDataModel: false,
        persistentSchedulerState: false,
      },
      wireKey: "modernDataModel",
    });
  });

  it("accepts the canonical modernDataModel key", () => {
    assertEquals(parseMemoryProtocolFlags({ modernDataModel: true }), {
      flags: {
        modernCellRep: false,
        modernDataModel: true,
        persistentSchedulerState: false,
      },
      wireKey: "modernDataModel",
    });
    assertEquals(parseMemoryProtocolFlags({ modernDataModel: false }), {
      flags: {
        modernCellRep: false,
        modernDataModel: false,
        persistentSchedulerState: false,
      },
      wireKey: "modernDataModel",
    });
  });

  it("accepts the canonical persistentSchedulerState key", () => {
    assertEquals(
      parseMemoryProtocolFlags({
        persistentSchedulerState: true,
      }),
      {
        flags: {
          modernCellRep: false,
          modernDataModel: false,
          persistentSchedulerState: true,
        },
        wireKey: "modernDataModel",
      },
    );
  });

  it("rejects values that are not a recognizable flags shape", () => {
    assertEquals(parseMemoryProtocolFlags(null), null);
    assertEquals(parseMemoryProtocolFlags(undefined), null);
    assertEquals(parseMemoryProtocolFlags("modernCellRep"), null);
    assertEquals(parseMemoryProtocolFlags([true]), null);
    assertEquals(parseMemoryProtocolFlags({ modernCellRep: "true" }), null);
    assertEquals(
      parseMemoryProtocolFlags({
        modernCellRep: true,
        persistentSchedulerState: "true",
      }),
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
