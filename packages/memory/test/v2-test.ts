import { describe, it } from "@std/testing/bdd";
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type EntityRef,
  entityRefFromString,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import {
  compatibleMemoryProtocolFlags,
  decodeMemoryBoundary,
  DEFAULT_BRANCH,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  parseMemoryProtocolFlags,
  resetCommitPreconditionsConfig,
  resetPersistentSchedulerStateConfig,
  resetSyncSchemaTableConfig,
  setCommitPreconditionsConfig,
  setPersistentSchedulerStateConfig,
  setSyncSchemaTableConfig,
  toDocumentPath,
  toDocumentSelector,
  toValuePath,
} from "../v2.ts";

const toEntityDocument = (
  value: unknown,
  source?: EntityRef,
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
    const source = entityRefFromString("abc123");
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

// ---------------------------------------------------------------------------
// Flag-mechanism test (explicitly tests both OFF and ON in one test)
// ---------------------------------------------------------------------------

describe("memory v2 flags", () => {
  it("reflects the active runtime storage flags", () => {
    resetModernCellRepConfig();
    resetPersistentSchedulerStateConfig();
    resetCommitPreconditionsConfig();
    resetSyncSchemaTableConfig();
    setModernCellRepConfig(false);
    setPersistentSchedulerStateConfig(false);
    setCommitPreconditionsConfig(false);
    setSyncSchemaTableConfig(false);

    assertEquals(getMemoryProtocolFlags(), {
      modernCellRep: false,
      persistentSchedulerState: false,
      commitPreconditions: false,
      syncSchemaTable: false,
    });

    setModernCellRepConfig(true);
    setPersistentSchedulerStateConfig(true);
    setCommitPreconditionsConfig(true);
    setSyncSchemaTableConfig(true);

    assertEquals(getMemoryProtocolFlags(), {
      modernCellRep: true,
      persistentSchedulerState: true,
      commitPreconditions: true,
      syncSchemaTable: true,
    });

    resetModernCellRepConfig();
    resetPersistentSchedulerStateConfig();
    resetCommitPreconditionsConfig();
    resetSyncSchemaTableConfig();
  });

  it("treats non-wire-shape flags as optional capabilities", () => {
    assert(compatibleMemoryProtocolFlags(
      {
        modernCellRep: true,
        persistentSchedulerState: true,
        commitPreconditions: true,
        syncSchemaTable: true,
      },
      {
        modernCellRep: true,
        persistentSchedulerState: false,
        commitPreconditions: false,
        syncSchemaTable: false,
      },
    ));
  });
});

describe("parseMemoryProtocolFlags", () => {
  it("accepts the modernCellRep key", () => {
    assertEquals(parseMemoryProtocolFlags({ modernCellRep: true }), {
      modernCellRep: true,
      persistentSchedulerState: false,
      commitPreconditions: false,
      syncSchemaTable: false,
    });
    assertEquals(parseMemoryProtocolFlags({ modernCellRep: false }), {
      modernCellRep: false,
      persistentSchedulerState: false,
      commitPreconditions: false,
      syncSchemaTable: false,
    });
  });

  it("accepts the canonical persistentSchedulerState key", () => {
    assertEquals(
      parseMemoryProtocolFlags({
        persistentSchedulerState: true,
      }),
      {
        modernCellRep: false,
        persistentSchedulerState: true,
        commitPreconditions: false,
        syncSchemaTable: false,
      },
    );
  });

  it("accepts the canonical commitPreconditions key", () => {
    assertEquals(
      parseMemoryProtocolFlags({
        commitPreconditions: true,
      }),
      {
        modernCellRep: false,
        persistentSchedulerState: false,
        commitPreconditions: true,
        syncSchemaTable: false,
      },
    );
  });

  it("accepts the canonical syncSchemaTable key", () => {
    assertEquals(
      parseMemoryProtocolFlags({
        syncSchemaTable: true,
      }),
      {
        modernCellRep: false,
        persistentSchedulerState: false,
        commitPreconditions: false,
        syncSchemaTable: true,
      },
    );
  });

  it("rejects values that are not a recognizable flags shape", () => {
    assertEquals(parseMemoryProtocolFlags(null), null);
    assertEquals(parseMemoryProtocolFlags(undefined), null);
    assertEquals(parseMemoryProtocolFlags("modernCellRep"), null);
    assertEquals(parseMemoryProtocolFlags([true]), null);
    assertEquals(parseMemoryProtocolFlags({ modernCellRep: "true" }), null);
    assertEquals(parseMemoryProtocolFlags({ syncSchemaTable: "true" }), null);
    assertEquals(
      parseMemoryProtocolFlags({
        modernCellRep: true,
        persistentSchedulerState: "true",
      }),
      null,
    );
    assertEquals(
      parseMemoryProtocolFlags({
        modernCellRep: true,
        commitPreconditions: "true",
      }),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// Boundary encode/decode dispatch test (explicitly tests OFF and ON paths)
// ---------------------------------------------------------------------------

describe("memory v2 boundary decode", () => {
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
