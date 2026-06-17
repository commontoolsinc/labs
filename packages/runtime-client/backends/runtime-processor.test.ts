import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  runtimeOptionsFromInitializationData,
  RuntimeProcessor,
  sanitizeForPostMessage,
} from "./runtime-processor.ts";
import {
  type CellRef,
  type CfcLabelView,
  RequestType,
} from "../protocol/mod.ts";
import { decodeMemoryBoundary } from "@commonfabric/memory/v2";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { cellRefToSigilLink } from "./utils.ts";
import { Runtime } from "@commonfabric/runner";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import * as V2Storage from "../../runner/src/storage/v2.ts";
import { parseLink } from "../../runner/src/link-utils.ts";

const cfcSigner = await Identity.fromPassphrase(
  "runtime-processor-cfc-label-tests",
);

class SharedV2SessionFactory implements V2Storage.SessionFactory {
  constructor(private readonly server: MemoryV2Server.Server) {}

  async create(space: MemorySpace) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.server),
    });
    const session = await client.mount(space);
    return { client, session };
  }
}

class SharedV2StorageManager extends V2Storage.StorageManager {
  constructor(options: V2Storage.Options, server: MemoryV2Server.Server) {
    super(options, new SharedV2SessionFactory(server));
  }
}

const createRuntime = () => {
  const server = new MemoryV2Server.Server();
  const storageManager = new SharedV2StorageManager({
    as: cfcSigner,
    memoryHost: new URL("memory://"),
  }, server);
  const runtime = new Runtime({
    apiUrl: new URL("http://localhost/"),
    storageManager,
  });
  return { runtime, storageManager };
};

// Handlers resolve their per-space piece context via getSpaceCtx
// (federation PR2). The duck-typed processors below are single-space:
// their context is always the home pieceManager/cc.
function homeSpaceCtx(this: { pieceManager?: unknown; cc?: unknown }) {
  return { pieceManager: this.pieceManager, cc: this.cc };
}

describe("page slug metadata", () => {
  it("reads slug metadata from the page document root", async () => {
    const reads: unknown[] = [];
    const processor = {
      getSpaceCtx: homeSpaceCtx,
      runtime: {
        getCellFromEntityId: () => ({
          sync: () => Promise.resolve(),
          getMetaRaw: (metaField: string) => {
            reads.push({
              space: "did:key:z6Mk-runtime-processor-slug",
              id: "of:fid1-slugged-piece",
              scope: "space",
              path: [metaField],
            });
            return metaField === "slug" ? "demo" : undefined;
          },
        }),
      },
      pieceManager: {
        getSpace: () => "did:key:z6Mk-runtime-processor-slug",
      },
    };

    const result = await (RuntimeProcessor.prototype as any).handlePageGetSlug
      .call(processor, {
        type: RequestType.PageGetSlug,
        pageId: "fid1-slugged-piece",
      });

    expect(result).toEqual({ slug: "demo" });
    expect(reads).toEqual([{
      space: "did:key:z6Mk-runtime-processor-slug",
      id: "of:fid1-slugged-piece",
      scope: "space",
      path: ["slug"],
    }]);
  });

  it("ignores non-string slug metadata", async () => {
    const processor = {
      getSpaceCtx: homeSpaceCtx,
      runtime: {
        getCellFromEntityId: () => ({
          sync: () => Promise.resolve(),
          getMetaRaw: (metaField: string) =>
            metaField === "slug" ? { not: "a slug" } : undefined,
        }),
      },
      pieceManager: {
        getSpace: () => "did:key:z6Mk-runtime-processor-slug",
      },
    };

    const result = await (RuntimeProcessor.prototype as any).handlePageGetSlug
      .call(processor, {
        type: RequestType.PageGetSlug,
        pageId: "fid1-slugged-piece",
      });

    expect(result).toEqual({ slug: undefined });
  });
});

describe("page slug redirects", () => {
  const space = "did:key:z6Mk-runtime-processor-page-redirect" as CellRef[
    "space"
  ];

  function mockCell(ref: CellRef, options: {
    raw?: unknown;
    schemaCell?: unknown;
    onPull?: () => void;
    patternLink?: unknown;
    onSync?: () => void;
  } = {}) {
    return {
      sync: () => {
        options.onSync?.();
        return Promise.resolve();
      },
      pull: () => {
        options.onPull?.();
        return Promise.resolve(options.raw);
      },
      getRaw: () => options.raw,
      getMetaRaw: (metaField: string) =>
        metaField === "pattern" ? options.patternLink : undefined,
      getAsLink: () => cellRefToSigilLink(ref),
      getAsNormalizedFullLink: () => ref,
      asSchemaFromLinks: () => options.schemaCell,
    };
  }

  function redirectRaw(ref: CellRef) {
    return {
      "/": {
        "link@1": {
          ...ref,
          overwrite: "redirect",
        },
      },
    };
  }

  it("renders slug redirects to output cells directly", async () => {
    const targetRef: CellRef = {
      id: "of:fid1-sub-page" as CellRef["id"],
      space,
      scope: "space",
      path: ["capture"],
    };
    const slugRef: CellRef = {
      id: "of:fid1-slug-doc" as CellRef["id"],
      space,
      scope: "space",
      path: [],
    };
    let targetSynced = false;
    const targetCell = mockCell(targetRef, {
      onSync: () => {
        targetSynced = true;
      },
    });
    const slugCell = mockCell(slugRef, { raw: redirectRaw(targetRef) });
    const manager = {
      get: () => {
        throw new Error("output-cell slug redirects should not load as pieces");
      },
    };
    const processor = {
      getSpaceCtx: homeSpaceCtx,
      pieceManager: { getSpace: () => space },
      runtime: {
        getCellFromEntityId: () => slugCell,
        getCellFromLink: () => targetCell,
      },
      cc: { manager: () => manager },
    };

    const result = await (RuntimeProcessor.prototype as any).handlePageGet
      .call(processor, {
        type: RequestType.PageGet,
        pageId: "fid1-slug-doc",
        runIt: true,
      });

    expect(targetSynced).toBe(true);
    expect(result.page.cell).toMatchObject(targetRef);
  });

  it("renders slug redirects to nested output cells directly", async () => {
    const targetRef: CellRef = {
      id: "of:fid1-parent-page" as CellRef["id"],
      space,
      scope: "space",
      path: ["activityTab"],
    };
    const slugRef: CellRef = {
      id: "of:fid1-slug-doc" as CellRef["id"],
      space,
      scope: "space",
      path: [],
    };
    const schemaRef: CellRef = {
      ...targetRef,
      schema: {
        type: "object",
        properties: {
          "$NAME": { type: "string" },
          "$UI": { type: "object" },
        },
        required: ["$NAME", "$UI"],
      },
    };
    // if we don't have a pattern link, the processor won't pull the cell and
    // thus won't pull the schema, so we have to include a pattern link
    const patternRef: CellRef = {
      id: "of:fid1-pattern-doc" as CellRef["id"],
      space,
      scope: "space",
      path: [],
    };
    let schemaPulled = false;
    const schemaCell = mockCell(schemaRef, {
      onPull: () => {
        schemaPulled = true;
      },
    });
    let targetSynced = false;
    const targetCell = mockCell(targetRef, {
      schemaCell,
      patternLink: redirectRaw(patternRef),
      onSync: () => {
        targetSynced = true;
      },
    });
    const slugCell = mockCell(slugRef, { raw: redirectRaw(targetRef) });
    const manager = {
      get: () => {
        throw new Error(
          "nested output-cell slug redirects should not load as pieces",
        );
      },
    };
    const processor = {
      getSpaceCtx: homeSpaceCtx,
      pieceManager: { getSpace: () => space },
      runtime: {
        getCellFromEntityId: () => slugCell,
        getCellFromLink: () => targetCell,
      },
      cc: { manager: () => manager },
    };

    const result = await (RuntimeProcessor.prototype as any).handlePageGet
      .call(processor, {
        type: RequestType.PageGet,
        pageId: "fid1-slug-doc",
        runIt: true,
      });

    expect(targetSynced).toBe(true);
    expect(schemaPulled).toBe(true);
    expect(result.page.cell).toMatchObject(schemaRef);
  });

  it("loads slug redirects to piece cells through the piece manager", async () => {
    const pieceRef: CellRef = {
      id: "of:fid1-piece" as CellRef["id"],
      space,
      scope: "space",
      path: [],
    };
    const resultRef: CellRef = {
      id: "of:fid1-piece-result" as CellRef["id"],
      space,
      scope: "space",
      path: [],
    };
    const slugRef: CellRef = {
      id: "of:fid1-slug-doc" as CellRef["id"],
      space,
      scope: "space",
      path: [],
    };
    const patternRef: CellRef = {
      id: "of:fid1-pattern-doc" as CellRef["id"],
      space,
      scope: "space",
      path: [],
    };
    const pieceCell = mockCell(pieceRef, {
      patternLink: redirectRaw(patternRef),
    });
    const resultCell = mockCell(resultRef);
    const slugCell = mockCell(slugRef, { raw: redirectRaw(pieceRef) });
    const calls: unknown[][] = [];
    const manager = {
      get: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(resultCell);
      },
    };
    const processor = {
      getSpaceCtx: homeSpaceCtx,
      pieceManager: { getSpace: () => space },
      runtime: {
        getCellFromEntityId: () => slugCell,
        getCellFromLink: () => pieceCell,
      },
      cc: { manager: () => manager },
    };

    const result = await (RuntimeProcessor.prototype as any).handlePageGet
      .call(processor, {
        type: RequestType.PageGet,
        pageId: "fid1-slug-doc",
        runIt: true,
      });

    expect(calls).toEqual([[pieceCell, true]]);
    expect(result.page.cell).toMatchObject(resultRef);
  });
});

describe("sanitizeForPostMessage", () => {
  describe("primitives", () => {
    it("passes through null and undefined", () => {
      expect(sanitizeForPostMessage(null)).toBe(null);
      expect(sanitizeForPostMessage(undefined)).toBe(undefined);
    });

    it("passes through numbers, strings, and booleans", () => {
      expect(sanitizeForPostMessage(42)).toBe(42);
      expect(sanitizeForPostMessage("hello")).toBe("hello");
      expect(sanitizeForPostMessage(true)).toBe(true);
    });
  });

  describe("functions", () => {
    it("converts functions to placeholder strings", () => {
      expect(sanitizeForPostMessage(() => {})).toBe("[Function]");
      expect(sanitizeForPostMessage(function named() {})).toBe("[Function]");
    });
  });

  describe("plain objects", () => {
    it("passes through simple objects", () => {
      const obj = { name: "test", count: 42 };
      expect(sanitizeForPostMessage(obj)).toEqual({ name: "test", count: 42 });
    });

    it("handles nested objects", () => {
      const obj = { outer: { inner: { value: 1 } } };
      expect(sanitizeForPostMessage(obj)).toEqual({
        outer: { inner: { value: 1 } },
      });
    });

    it("converts function properties to placeholders", () => {
      const obj = { name: "test", callback: () => {} };
      expect(sanitizeForPostMessage(obj)).toEqual({
        name: "test",
        callback: "[Function]",
      });
    });
  });

  describe("arrays", () => {
    it("handles arrays of primitives", () => {
      expect(sanitizeForPostMessage([1, 2, 3])).toEqual([1, 2, 3]);
    });

    it("handles arrays of objects", () => {
      const arr = [{ a: 1 }, { b: 2 }];
      expect(sanitizeForPostMessage(arr)).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it("converts function elements to placeholders", () => {
      const arr = [1, () => {}, 3];
      expect(sanitizeForPostMessage(arr)).toEqual([1, "[Function]", 3]);
    });
  });

  describe("circular references", () => {
    it("detects and handles circular references", () => {
      const obj: Record<string, unknown> = { name: "test" };
      obj.self = obj;
      expect(sanitizeForPostMessage(obj)).toEqual({
        name: "test",
        self: "[Circular]",
      });
    });

    it("handles circular arrays", () => {
      const arr: unknown[] = [1, 2];
      arr.push(arr);
      expect(sanitizeForPostMessage(arr)).toEqual([1, 2, "[Circular]"]);
    });
  });

  describe("depth limit", () => {
    it("stops at max depth", () => {
      const deepObj = {
        l1: { l2: { l3: { l4: { l5: { l6: "too deep" } } } } },
      };
      const result = sanitizeForPostMessage(deepObj) as Record<string, unknown>;
      // At depth 5, l6 should be "[Max depth exceeded]"
      expect(
        (
          (
            ((result.l1 as Record<string, unknown>).l2 as Record<
              string,
              unknown
            >)
              .l3 as Record<string, unknown>
          ).l4 as Record<string, unknown>
        ).l5,
      ).toBe("[Max depth exceeded]");
    });
  });

  describe("objects with throwing property access", () => {
    it("handles objects with properties that throw on read", () => {
      // Create an object where reading a specific property throws
      const obj = {
        safe: "value",
        get dangerous(): never {
          throw new Error("Cannot read this property");
        },
      };

      const result = sanitizeForPostMessage(obj) as Record<string, unknown>;
      expect(result.safe).toBe("value");
      expect(result.dangerous).toBe("[Unreadable]");
    });

    it("handles proxies with throwing get trap", () => {
      const throwingProxy = new Proxy(
        {},
        {
          get() {
            throw new Error("Cannot access property");
          },
          ownKeys() {
            return ["problematic"];
          },
          getOwnPropertyDescriptor() {
            return { enumerable: true, configurable: true };
          },
        },
      );

      // isCellResult() probes symbol-backed access first, so a hostile get trap
      // is treated as an uncloneable object before the plain-object walker runs.
      const result = sanitizeForPostMessage(throwingProxy);
      expect(result).toBe("[Object - uncloneable]");
    });

    it("handles proxies that throw on Object.keys", () => {
      const throwingProxy = new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("Cannot list keys");
          },
        },
      );

      // When we can't iterate, we fall back to placeholder
      const result = sanitizeForPostMessage(throwingProxy);
      expect(result).toBe("[Object - uncloneable]");
    });
  });

  describe("mixed structures", () => {
    it("handles complex nested structures with various types", () => {
      const complex = {
        name: "root",
        items: [
          { id: 1, process: () => {} },
          { id: 2, nested: { deep: true } },
        ],
        metadata: {
          count: 42,
          handler: function handle() {},
        },
      };

      expect(sanitizeForPostMessage(complex)).toEqual({
        name: "root",
        items: [
          { id: 1, process: "[Function]" },
          { id: 2, nested: { deep: true } },
        ],
        metadata: {
          count: 42,
          handler: "[Function]",
        },
      });
    });
  });
});

describe("RuntimeProcessor diagnosis helpers", () => {
  it("passes detectNonIdempotent duration through to scheduler.runDiagnosis", async () => {
    const expected = {
      nonIdempotent: [],
      cycles: [],
      duration: 321,
      busyTime: 123,
    };
    let receivedDuration: number | undefined;
    const processor = {
      runtime: {
        scheduler: {
          runDiagnosis: (durationMs?: number) => {
            receivedDuration = durationMs;
            return expected;
          },
        },
      },
    } as unknown as RuntimeProcessor;

    const response = await RuntimeProcessor.prototype.detectNonIdempotent.call(
      processor,
      {
        type: RequestType.DetectNonIdempotent,
        durationMs: 2500,
      },
    );

    expect(receivedDuration).toBe(2500);
    expect(response).toEqual({ result: expected });
  });

  it("routes settle and trigger trace helpers to the scheduler", () => {
    const expected = {
      iterations: [{
        workSetSize: 3,
        orderSize: 2,
        actionsRun: 2,
        actions: [{ id: "action:test", type: "computation" as const }],
        durationMs: 12.5,
      }],
      totalDurationMs: 12.5,
      settledEarly: true,
      initialSeedCount: 1,
    };
    const history = [{
      recordedAt: 1234.5,
      stats: expected,
    }];
    const actionTrace = [{
      recordedAt: 2234.5,
      actionId: "action:compute",
      actionType: "computation" as const,
      parentActionId: "action:parent",
      durationMs: 3.5,
      declaredWrites: [{
        space: "did:key:test",
        entityId: "cell-2",
        path: [],
      }],
      actualWrites: [{
        space: "did:key:test",
        entityId: "cell-2",
        path: [],
      }],
    }];
    const triggerTrace = [{
      recordedAt: 2345.6,
      notificationType: "commit",
      changeIndex: 1,
      matchedActionCount: 1,
      mode: "pull" as const,
      writerActionId: "action:writer",
      space: "did:key:test",
      entityId: "cell-1",
      path: ["items", "0"],
      before: { kind: "undefined" as const },
      after: { kind: "object" as const, size: 2 },
      triggered: [{
        actionId: "action:reader",
        actionType: "computation" as const,
        mode: "pull" as const,
        decision: "mark-dirty" as const,
        pendingBefore: false,
        pendingAfter: false,
        dirtyBefore: false,
        dirtyAfter: true,
        scheduledEffects: [{
          actionId: "action:effect",
          pendingBefore: false,
          dirtyBefore: false,
        }],
      }],
    }];
    const settleEnabledValues: boolean[] = [];
    const actionRunEnabledValues: boolean[] = [];
    const triggerEnabledValues: boolean[] = [];
    const writeTraceMatchers: unknown[] = [];
    const writeTrace = [{
      recordedAt: 2456.7,
      space: "did:key:test",
      entityId: "of:cell-1",
      path: [],
      match: "exact" as const,
      label: "watched root write",
      result: "ok" as const,
      valueKind: "object" as const,
      stack: "Error\n  at writeValueOrThrow",
    }];
    const processor = {
      runtime: {
        scheduler: {
          setSettleStatsEnabled: (enabled: boolean) => {
            settleEnabledValues.push(enabled);
          },
          getSettleStats: () => expected,
          getSettleStatsHistory: () => history,
          setActionRunTraceEnabled: (enabled: boolean) => {
            actionRunEnabledValues.push(enabled);
          },
          getActionRunTrace: () => actionTrace,
          setTriggerTraceEnabled: (enabled: boolean) => {
            triggerEnabledValues.push(enabled);
          },
          getTriggerTrace: () => triggerTrace,
        },
        getWriteStackTrace: () => writeTrace,
        setWriteStackTraceMatchers: (matchers: unknown[]) => {
          writeTraceMatchers.push(matchers);
        },
      },
    } as unknown as RuntimeProcessor;

    RuntimeProcessor.prototype.setSettleStatsEnabled.call(processor, {
      type: RequestType.SetSettleStatsEnabled,
      enabled: true,
    });
    RuntimeProcessor.prototype.setActionRunTraceEnabled.call(processor, {
      type: RequestType.SetActionRunTraceEnabled,
      enabled: true,
    });
    RuntimeProcessor.prototype.setTriggerTraceEnabled.call(processor, {
      type: RequestType.SetTriggerTraceEnabled,
      enabled: true,
    });

    const response = RuntimeProcessor.prototype.getSettleStats.call(processor, {
      type: RequestType.GetSettleStats,
    });
    const historyResponse = RuntimeProcessor.prototype.getSettleStatsHistory
      .call(processor, {
        type: RequestType.GetSettleStatsHistory,
      });
    const actionTraceResponse = RuntimeProcessor.prototype.getActionRunTrace
      .call(processor, {
        type: RequestType.GetActionRunTrace,
      });
    const triggerTraceResponse = RuntimeProcessor.prototype.getTriggerTrace
      .call(
        processor,
        {
          type: RequestType.GetTriggerTrace,
        },
      );
    const writeTraceResponse = RuntimeProcessor.prototype.getWriteStackTrace
      .call(
        processor,
        {
          type: RequestType.GetWriteStackTrace,
        },
      );

    expect(settleEnabledValues).toEqual([true]);
    expect(actionRunEnabledValues).toEqual([true]);
    expect(triggerEnabledValues).toEqual([true]);
    expect(response).toEqual({ stats: expected });
    expect(historyResponse).toEqual({ history });
    expect(actionTraceResponse).toEqual({ trace: actionTrace });
    expect(triggerTraceResponse).toEqual({ trace: triggerTrace });
    expect(writeTraceResponse).toEqual({
      trace: writeTrace,
    });

    RuntimeProcessor.prototype.setWriteStackTraceMatchers.call(
      processor,
      {
        type: RequestType.SetWriteStackTraceMatchers,
        matchers: [],
      },
    );
    expect(writeTraceMatchers).toEqual([[]]);
  });
});

describe("RuntimeProcessor blob upload IPC", () => {
  it("posts FabricBytes contents to the blob route and returns an absolute URL", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl: string | undefined;
    let requestedPayload: unknown;
    globalThis.fetch = (input, init) => {
      requestedUrl = input.toString();
      requestedPayload = decodeMemoryBoundary(init?.body as string);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "fid1:test",
            url: "blobs/test.png",
          }),
          {
            status: 201,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    };
    // The constructor performs full runtime initialization; this focused unit
    // test calls the handler with the fields it reads directly.
    const hostForSpaceCalls: string[] = [];
    const processor = {
      runtime: {
        hostForSpace: (space: string) => {
          hostForSpaceCalls.push(space);
          return new URL("http://toolshed.test/base");
        },
      },
    } as unknown as RuntimeProcessor;

    try {
      await expect(
        RuntimeProcessor.prototype.handleUploadBlob.call(processor, {
          type: RequestType.UploadBlob,
          space: "did:key:test-space" as never,
          contentType: "image/png",
          body: [1, 2, 3],
          suffix: "png",
        }),
      ).resolves.toEqual({
        id: "fid1:test",
        url: "http://toolshed.test/did:key:test-space/blobs/test.png",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestedUrl).toBe(
      "http://toolshed.test/did:key:test-space/blobs/upload.png",
    );
    // The host is resolved for the REQUEST's space, not any init space.
    expect(hostForSpaceCalls).toEqual(["did:key:test-space"]);
    expect(requestedPayload).toEqual({
      type: "image/png",
      body: new FabricBytes(new Uint8Array([1, 2, 3])),
    });
  });
});

describe("RuntimeProcessor home pattern IPC", () => {
  it("uses the default-pattern metadata fast path when the home pattern is already instantiated", async () => {
    const defaultPatternRef: CellRef = {
      id: "of:default-pattern-result" as CellRef["id"],
      space: "did:key:test-home" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const patternRef: CellRef = {
      id: "of:default-pattern-source" as CellRef["id"],
      space: "did:key:test-home" as CellRef["space"],
      scope: "space",
      path: [],
    };
    let startedCell: unknown;
    let idleCalled = false;
    let defaultPatternSynced = false;

    const defaultPatternCell = {
      ...defaultPatternRef,
      getAsLink: () => cellRefToSigilLink(defaultPatternRef),
      getAsNormalizedFullLink: () => defaultPatternRef,
      getMetaRaw: (metaField: string) =>
        defaultPatternSynced && metaField === "pattern"
          ? cellRefToSigilLink(patternRef)
          : undefined,
      sync: () => {
        defaultPatternSynced = true;
        return Promise.resolve();
      },
    };
    const processor = {
      runtime: {
        getHomeSpaceCell: () => ({
          sync: () => Promise.resolve(),
          key: (key: string) => {
            expect(key).toBe("defaultPattern");
            return {
              get: () => ({
                resolveAsCell: () => defaultPatternCell,
              }),
            };
          },
        }),
        start: (cell: unknown) => {
          startedCell = cell;
          return Promise.resolve();
        },
        idle: () => {
          idleCalled = true;
          return Promise.resolve();
        },
      },
    } as unknown as RuntimeProcessor;

    await expect(
      RuntimeProcessor.prototype.handleEnsureHomePatternRunning.call(
        processor,
        { type: RequestType.EnsureHomePatternRunning },
      ),
    ).resolves.toEqual({ cell: defaultPatternRef });
    expect(startedCell).toBe(defaultPatternCell);
    expect(idleCalled).toBe(true);
  });
});

describe("RuntimeProcessor CFC label IPC", () => {
  it("returns a label view for a cell ref", async () => {
    const ref: CellRef = {
      id: "of:cfc-label-cell" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const processor = {
      runtime: {
        getCellFromLink: () => ({
          runtime: {
            readTx: () => ({
              readOrThrow: () => ({
                value: "labelled data",
                cfc: {
                  version: 1,
                  schemaHash: "test-schema",
                  labelMap: {
                    version: 1,
                    entries: [{
                      path: [],
                      label: { confidentiality: ["prompt-risk"] },
                    }],
                  },
                },
              }),
            }),
          },
          getAsNormalizedFullLink: () => ref,
          getMetaRaw: () => undefined,
          sync: () => Promise.resolve(),
        }),
      },
    } as unknown as RuntimeProcessor;

    await expect(
      RuntimeProcessor.prototype.handleCellGetCfcLabel.call(processor, {
        type: RequestType.CellGetCfcLabel,
        cell: ref,
      }),
    ).resolves.toEqual({
      cfcLabel: {
        version: 1,
        entries: [{
          path: [],
          label: { confidentiality: ["prompt-risk"] },
        }],
      },
    });
  });

  it("redacts Caveat.source from the introspection response (audit 28b)", async () => {
    const ref: CellRef = {
      id: "of:cfc-caveat-cell" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const processor = {
      runtime: {
        getCellFromLink: () => ({
          runtime: {
            readTx: () => ({
              readOrThrow: () => ({
                value: "labelled data",
                cfc: {
                  version: 1,
                  schemaHash: "test-schema",
                  labelMap: {
                    version: 1,
                    entries: [{
                      path: [],
                      label: {
                        confidentiality: [{
                          type: CFC_ATOM_TYPE.Caveat,
                          kind: "derived-from",
                          source: "did:key:alice",
                        }],
                      },
                    }],
                  },
                },
              }),
            }),
          },
          getAsNormalizedFullLink: () => ref,
          getMetaRaw: () => undefined,
          sync: () => Promise.resolve(),
        }),
      },
    } as unknown as RuntimeProcessor;

    const response = await RuntimeProcessor.prototype.handleCellGetCfcLabel
      .call(
        processor,
        { type: RequestType.CellGetCfcLabel, cell: ref },
      );
    const atom = response.cfcLabel?.entries[0].label.confidentiality
      ?.[0] as Record<string, unknown>;
    // The caveat survives with its kind/type, but the source identity is gone.
    expect(atom.type).toBe(CFC_ATOM_TYPE.Caveat);
    expect(atom.kind).toBe("derived-from");
    expect("source" in atom).toBe(false);
  });

  it("returns label views on resolved cell refs", () => {
    const sourceRef: CellRef = {
      id: "of:cfc-label-source" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const resolvedRef: CellRef = {
      id: "of:cfc-label-resolved" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const resolvedCell = {
      getAsLink: () => ({
        "/": {
          "link@1": resolvedRef,
        },
      }),
      getAsNormalizedFullLink: () => resolvedRef,
      runtime: {
        readTx: () => ({
          readOrThrow: () => ({
            value: "resolved value",
            cfc: {
              version: 1,
              schemaHash: "test-schema",
              labelMap: {
                version: 1,
                entries: [{
                  path: [],
                  label: { integrity: ["authored-by-bob"] },
                }],
              },
            },
          }),
        }),
      },
    };
    const sourceCell = {
      resolveAsCell: () => resolvedCell,
    };
    const processor = {
      runtime: {
        getCellFromLink: () => sourceCell,
      },
    } as unknown as RuntimeProcessor;

    expect(RuntimeProcessor.prototype.handleCellResolveAsCell.call(processor, {
      type: RequestType.CellResolveAsCell,
      cell: sourceRef,
    })).toEqual({
      cell: {
        ...resolvedRef,
        cfcLabelView: {
          version: 1,
          entries: [{
            path: [],
            label: { integrity: ["authored-by-bob"] },
          }],
        },
      },
    });
  });

  it("does not look up CFC labels from a result meta cell", async () => {
    const resultRef: CellRef = {
      id: "of:cfc-label-result" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const sourceRef: CellRef = {
      id: "of:cfc-label-source" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    let resultSynced = false;
    let sourceSynced = false;
    const runtime = {
      readTx: () => ({
        readOrThrow: (address: { id: string }) =>
          address.id === sourceRef.id
            ? {
              value: "metadata cell",
              cfc: {
                version: 1,
                schemaHash: "test-schema",
                labelMap: {
                  version: 1,
                  entries: [{
                    path: [],
                    label: { confidentiality: ["source-label"] },
                  }],
                },
              },
            }
            : { value: "result cell" },
      }),
      getCellFromLink: (link: { id?: string }) =>
        link.id === sourceRef.id ? sourceCell : resultCell,
    };
    const sourceCell = {
      runtime,
      getAsNormalizedFullLink: () => sourceRef,
      getMetaRaw: (_metaField: string) => undefined,
      sync: () => {
        sourceSynced = true;
        return Promise.resolve();
      },
    };
    const resultCell = {
      runtime,
      getAsNormalizedFullLink: () => resultRef,
      resultRef,
      getMetaRaw: (metaField: string) =>
        resultSynced && metaField === "result"
          ? cellRefToSigilLink(sourceRef)
          : undefined,
      sync: () => {
        resultSynced = true;
        return Promise.resolve();
      },
    };
    const processor = { runtime } as unknown as RuntimeProcessor;

    await expect(Promise.resolve(
      RuntimeProcessor.prototype.handleCellGetCfcLabel.call(processor, {
        type: RequestType.CellGetCfcLabel,
        cell: resultRef,
      }),
    )).resolves.toEqual({
      cfcLabel: undefined,
    });
    expect(resultSynced).toBe(true);
    expect(sourceSynced).toBe(false);
  });

  it("syncs pattern and argument metadata links before reading labels", async () => {
    const resultRef: CellRef = {
      id: "of:cfc-label-sync-result" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const patternRef: CellRef = {
      id: "of:cfc-label-sync-pattern" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const argumentRef: CellRef = {
      id: "of:cfc-label-sync-argument" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const syncLog: string[] = [];
    const cells = new Map<string, unknown>();
    const runtime = {
      getCellFromLink: (link: CellRef) => cells.get(link.id),
      readTx: () => {
        return {
          readOrThrow: () => ({
            version: 1,
            schemaHash: "test-schema",
            labelMap: {
              version: 1,
              entries: [{
                path: [],
                label: { confidentiality: ["result-label"] },
              }],
            },
          }),
        };
      },
    };
    const makeCell = (
      name: string,
      ref: CellRef,
      links: Partial<Record<"pattern" | "argument", CellRef>> = {},
    ) => {
      let synced = false;
      return {
        ...ref,
        sourceURI: `${ref.space}/${ref.scope}/${ref.id}`,
        runtime,
        getAsNormalizedFullLink: () => ref,
        getMetaRaw: (metaField: "pattern" | "argument") => {
          return synced && links[metaField] !== undefined
            ? cellRefToSigilLink(links[metaField]!)
            : undefined;
        },
        sync: () => {
          synced = true;
          syncLog.push(name);
          return Promise.resolve();
        },
      };
    };
    cells.set(
      resultRef.id,
      makeCell("result", resultRef, {
        pattern: patternRef,
        argument: argumentRef,
      }),
    );
    cells.set(patternRef.id, makeCell("pattern", patternRef));
    cells.set(argumentRef.id, makeCell("argument", argumentRef));
    const processor = { runtime } as unknown as RuntimeProcessor;

    await expect(
      RuntimeProcessor.prototype.handleCellGetCfcLabel.call(processor, {
        type: RequestType.CellGetCfcLabel,
        cell: resultRef,
      }),
    ).resolves.toEqual({
      cfcLabel: {
        version: 1,
        entries: [{
          path: [],
          label: { confidentiality: ["result-label"] },
        }],
      },
    });

    expect(syncLog).toEqual([
      "result",
      "pattern",
      "argument",
      "result",
    ]);
  });

  it("does not loop when metadata links form a cycle", async () => {
    const resultRef: CellRef = {
      id: "of:cfc-label-cycle-result" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const patternRef: CellRef = {
      id: "of:cfc-label-cycle-pattern" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };
    const syncLog: string[] = [];
    const cells = new Map<string, unknown>();
    const runtime = {
      getCellFromLink: (link: CellRef) => cells.get(link.id),
      readTx: () => ({
        readOrThrow: () => undefined,
      }),
    };
    const makeCell = (
      name: string,
      ref: CellRef,
      links: Partial<Record<"pattern" | "argument", CellRef>> = {},
    ) => {
      let synced = false;
      return {
        ...ref,
        sourceURI: `${ref.space}/${ref.scope}/${ref.id}`,
        runtime,
        getAsNormalizedFullLink: () => ref,
        getMetaRaw: (metaField: "pattern" | "argument") => {
          return synced && links[metaField] !== undefined
            ? cellRefToSigilLink(links[metaField]!)
            : undefined;
        },
        sync: () => {
          synced = true;
          syncLog.push(name);
          return Promise.resolve();
        },
      };
    };
    cells.set(
      resultRef.id,
      makeCell("result", resultRef, {
        pattern: patternRef,
      }),
    );
    cells.set(
      patternRef.id,
      makeCell("pattern", patternRef, {
        argument: resultRef,
      }),
    );
    const processor = { runtime } as unknown as RuntimeProcessor;

    await expect(
      RuntimeProcessor.prototype.handleCellGetCfcLabel.call(processor, {
        type: RequestType.CellGetCfcLabel,
        cell: resultRef,
      }),
    ).resolves.toEqual({ cfcLabel: undefined });

    expect(syncLog).toEqual(["result", "pattern", "result"]);
  });

  it("ignores schema-bearing anyOf refs when reading nested stored labels", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const pieceSchema = {
        $ref: "#/$defs/TrustedMessage",
        $defs: {
          TrustedMessage: {
            anyOf: [
              { $ref: "#/$defs/TrustedMessageAlice" },
              { $ref: "#/$defs/TrustedMessageBob" },
            ],
          },
          TrustedMessageAlice: {
            type: "object",
            properties: {
              id: {
                type: "string",
                enum: ["alice"],
              },
              body: { type: "string" },
            },
            required: ["id", "body"],
            ifc: {
              integrity: [{
                kind: "authored-by",
                subject: "alice",
              }],
            },
          },
          TrustedMessageBob: {
            type: "object",
            properties: {
              id: {
                type: "string",
                enum: ["bob"],
              },
              body: { type: "string" },
            },
            required: ["id", "body"],
            ifc: {
              integrity: [{
                kind: "authored-by",
                subject: "bob",
              }],
            },
          },
        },
      } as const;
      const rootSchema = {
        type: "object",
        properties: {
          messages: {
            type: "array",
            items: {
              type: "object",
              properties: {
                piece: pieceSchema,
              },
              required: ["piece"],
            },
          },
        },
        required: ["messages"],
      } as const;

      const root = runtime.getCell(
        cfcSigner.did(),
        "cfc-label-repro",
        rootSchema,
      );
      const tx = runtime.edit() as any;
      tx.setCfcEnforcementMode("enforce-explicit");
      (root.withTx(tx) as any).set({
        messages: [{ piece: { id: "alice", body: "hello" } }],
      });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();

      const replica = storageManager.open(cfcSigner.did())
        .replica as unknown as {
          getDocument(id: string): {
            value?: { messages?: unknown[] };
          } | undefined;
        };
      const rootId = parseLink(root.getAsLink()).id!;
      const nestedId = parseLink(
        replica.getDocument(rootId)?.value?.messages?.[0],
      )!.id!;
      const processor = { runtime } as unknown as RuntimeProcessor;

      const response = await RuntimeProcessor.prototype.handleCellGetCfcLabel
        .call(
          processor,
          {
            type: RequestType.CellGetCfcLabel,
            cell: {
              id: nestedId as CellRef["id"],
              space: cfcSigner.did() as CellRef["space"],
              scope: "space",
              path: ["piece"],
              schema: pieceSchema,
            },
          },
        );
      expect(response.cfcLabel).toBeDefined();
      expect(response.cfcLabel?.version).toBe(1);
      expect(response.cfcLabel?.entries).toEqual([{
        path: [],
        label: {
          integrity: [{
            kind: "authored-by",
            subject: "alice",
          }],
        },
      }]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("reads nested stored labels after push when child refs rely on parent defs", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const rootSchema = {
        type: "object",
        properties: {
          messages: {
            type: "array",
            items: {
              $ref: "#/$defs/SharedMessageEntry",
            },
          },
        },
        required: ["messages"],
        $defs: {
          SharedMessageEntry: {
            type: "object",
            properties: {
              piece: {
                $ref: "#/$defs/TrustedMessage",
              },
            },
            required: ["piece"],
          },
          TrustedMessage: {
            anyOf: [
              { $ref: "#/$defs/TrustedMessageAlice" },
              { $ref: "#/$defs/TrustedMessageBob" },
            ],
          },
          TrustedMessageAlice: {
            type: "object",
            properties: {
              id: {
                type: "string",
                enum: ["alice-message"],
              },
              author: {
                type: "object",
                properties: {
                  id: {
                    type: "string",
                    enum: ["alice"],
                  },
                },
                required: ["id"],
              },
              body: { type: "string" },
            },
            required: ["id", "author", "body"],
            ifc: {
              integrity: [{
                kind: "authored-by",
                subject: "alice",
              }],
            },
          },
          TrustedMessageBob: {
            type: "object",
            properties: {
              id: {
                type: "string",
                enum: ["bob-message"],
              },
              author: {
                type: "object",
                properties: {
                  id: {
                    type: "string",
                    enum: ["bob"],
                  },
                },
                required: ["id"],
              },
              body: { type: "string" },
            },
            required: ["id", "author", "body"],
            ifc: {
              integrity: [{
                kind: "authored-by",
                subject: "bob",
              }],
            },
          },
        },
      } as const;

      const root = runtime.getCell(
        cfcSigner.did(),
        "cfc-label-parent-defs-push",
        rootSchema,
      );

      const seed = runtime.edit();
      seed.setCfcEnforcementMode("enforce-explicit");
      root.withTx(seed).set({ messages: [] });
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      root.withTx(tx).key("messages").push({
        piece: {
          id: "alice-message",
          author: { id: "alice" },
          body: "hello",
        },
      });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const replica = storageManager.open(cfcSigner.did())
        .replica as unknown as {
          getDocument(id: string): {
            value?: { messages?: unknown[] };
          } | undefined;
        };
      const rootId = parseLink(root.getAsLink()).id!;
      const nestedId = parseLink(
        replica.getDocument(rootId)?.value?.messages?.[0],
      )!.id!;
      const processor = { runtime } as unknown as RuntimeProcessor;

      const response = await RuntimeProcessor.prototype.handleCellGetCfcLabel
        .call(
          processor,
          {
            type: RequestType.CellGetCfcLabel,
            cell: {
              id: nestedId as CellRef["id"],
              space: cfcSigner.did() as CellRef["space"],
              scope: "space",
              path: ["piece"],
              schema: { $ref: "#/$defs/TrustedMessage" },
            },
          },
        );
      expect(response.cfcLabel).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: {
            integrity: [{
              kind: "authored-by",
              subject: "alice",
            }],
          },
        }],
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

describe("RuntimeProcessor CFC commit preparation", () => {
  const ref: CellRef = {
    id: "of:cfc-client-write" as CellRef["id"],
    space: "did:key:test" as CellRef["space"],
    scope: "space",
    path: [],
    schema: {
      type: "string",
      ifc: { confidentiality: ["client-write"] },
    },
  };

  const createProcessor = () => {
    let prepared = false;
    const tx = {
      commit: () => {
        expect(prepared).toBe(true);
        return Promise.resolve({ ok: {} });
      },
    };
    const cellWithTx = {
      set: (value: unknown) => {
        expect(value).toBe("new value");
      },
      send: (value: unknown) => {
        expect(value).toBe("new value");
      },
    };
    let sent = false;
    cellWithTx.send = (value: unknown) => {
      expect(value).toBe("new value");
      sent = true;
    };
    return {
      processor: {
        isDisposed: () => false,
        cellSetLatest: new Map<
          string,
          { seq: number; value: unknown; retriesLeft: number }
        >(),
        cellSetChains: new Map<string, Promise<void>>(),
        commitLatestForKey: (RuntimeProcessor.prototype as unknown as {
          commitLatestForKey: (...a: unknown[]) => Promise<void>;
        }).commitLatestForKey,
        pendingCellWrites: new Set<Promise<unknown>>(),
        runtime: {
          edit: () => tx,
          prepareTxForCommit: (candidate: unknown) => {
            expect(candidate).toBe(tx);
            prepared = true;
          },
          getCellFromLink: (candidate: unknown) => {
            expect(candidate).toBe(ref);
            return {
              withTx: (candidateTx: unknown) => {
                expect(candidateTx).toBe(tx);
                return cellWithTx;
              },
            };
          },
        },
      } as unknown as RuntimeProcessor,
      wasSent: () => sent,
    };
  };

  const flushTicks = async (n = 10) => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  };

  it("prepares cell set transactions before committing", async () => {
    const { processor } = createProcessor();

    RuntimeProcessor.prototype.handleCellSet.call(processor, {
      type: RequestType.CellSet,
      cell: ref,
      value: "new value",
    });
    await flushTicks();
  });

  it("prepares cell send transactions before committing", async () => {
    const { processor, wasSent } = createProcessor();

    RuntimeProcessor.prototype.handleCellSend.call(processor, {
      type: RequestType.CellSend,
      cell: ref,
      event: "new value",
    });
    expect(wasSent()).toBe(true);
    await flushTicks();
  });
});

describe("runtime-client CellRef conversion", () => {
  it("preserves carried label views in transient sigil links", () => {
    const cfcLabelView: CfcLabelView = {
      version: 1,
      entries: [{
        path: [],
        label: { integrity: ["selected-by-alice"] },
      }],
    };
    const ref: CellRef = {
      id: "of:cfc-label-cell" as CellRef["id"],
      space: "did:key:z6MkrX123abc" as CellRef["space"],
      scope: "space",
      path: ["value"],
      cfcLabelView,
    };

    expect(cellRefToSigilLink(ref)).toEqual({
      "/": {
        "link@1": {
          id: ref.id,
          space: ref.space,
          scope: "space",
          path: ref.path,
          cfcLabelView,
        },
      },
    });
  });
});

describe("runtimeOptionsFromInitializationData", () => {
  it("threads CFC initialization settings into runtime options", () => {
    const telemetry = { marker() {} } as unknown as Parameters<
      typeof runtimeOptionsFromInitializationData
    >[2];
    const storageManager = {
      as: { did: () => "did:key:worker" },
    } as unknown as Parameters<typeof runtimeOptionsFromInitializationData>[1];

    const options = runtimeOptionsFromInitializationData(
      {
        apiUrl: "http://worker.test/",
        identity: {} as never,
        spaceDid: "did:key:space",
        cfcEnforcementMode: "enforce-explicit",
        trustSnapshot: {
          id: "principal:did:key:worker",
          actingPrincipal: "did:key:worker",
        },
      },
      storageManager,
      telemetry,
    );

    expect(options.cfcEnforcementMode).toBe("enforce-explicit");
    expect(options.trustSnapshotProvider?.()).toEqual({
      id: "principal:did:key:worker",
      actingPrincipal: "did:key:worker",
    });
  });
});

// Federation PR2: one worker serves page operations for many spaces.
// getSpaceCtx resolves the per-space PieceManager/PiecesController,
// lazily for foreign spaces, over the shared runtime/storage.
describe("RuntimeProcessor per-space piece contexts", () => {
  const getSpaceCtx = (RuntimeProcessor.prototype as any).getSpaceCtx;

  async function makeProcessorState() {
    const { runtime } = createRuntime();
    const { PieceManager } = await import("@commonfabric/piece");
    const { PiecesController } = await import("@commonfabric/piece/ops");
    const homeSpace = cfcSigner.did();
    const pieceManager = new PieceManager(
      { as: cfcSigner, space: homeSpace },
      runtime,
    );
    const cc = new PiecesController(pieceManager);
    const processor = {
      runtime,
      identity: cfcSigner,
      space: homeSpace,
      spaces: new Map([[homeSpace, { pieceManager, cc }]]),
      pieceManager,
      cc,
      getSpaceCtx,
    };
    return { processor, runtime, homeSpace };
  }

  it("resolves the home space to the initialize-time context and rejects a missing space", async () => {
    const { processor, runtime, homeSpace } = await makeProcessorState();
    try {
      expect(processor.getSpaceCtx(homeSpace)).toBe(
        processor.spaces.get(homeSpace),
      );
      expect(processor.getSpaceCtx(homeSpace).pieceManager).toBe(
        processor.pieceManager,
      );
      expect(() =>
        (processor as { getSpaceCtx: (s?: string) => unknown })
          .getSpaceCtx()
      ).toThrow("name a space");
    } finally {
      await runtime.dispose();
    }
  });

  it("lazily builds a distinct, cached context for a foreign space", async () => {
    const { processor, runtime, homeSpace } = await makeProcessorState();
    const spaceB = (await Identity.fromPassphrase(
      "runtime-processor-space-b",
    )).did();
    try {
      const ctxB = processor.getSpaceCtx(spaceB);
      expect(ctxB.pieceManager).not.toBe(processor.pieceManager);
      expect(ctxB.pieceManager.getSpace()).toBe(spaceB);
      // Cached: the same context comes back, and the home context is intact.
      expect(processor.getSpaceCtx(spaceB)).toBe(ctxB);
      expect(processor.getSpaceCtx(homeSpace).pieceManager).toBe(
        processor.pieceManager,
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("handlePageGet with a space resolves the page in that space", async () => {
    const { processor, runtime, homeSpace } = await makeProcessorState();
    const spaceB = (await Identity.fromPassphrase(
      "runtime-processor-space-b",
    )).did();
    const handlePageGet = (RuntimeProcessor.prototype as any).handlePageGet;
    try {
      const resHome = await handlePageGet.call(processor, {
        type: RequestType.PageGet,
        pageId: "fid1-cross-space-probe",
        runIt: false,
        space: homeSpace,
      });
      const resB = await handlePageGet.call(processor, {
        type: RequestType.PageGet,
        pageId: "fid1-cross-space-probe",
        runIt: false,
        space: spaceB,
      });
      expect(resHome.page.cell.space).toBe(homeSpace);
      expect(resB.page.cell.space).toBe(spaceB);
    } finally {
      await runtime.dispose();
    }
  });

  it("handleRuntimeSynced awaits every opened space, naming none", async () => {
    const { processor, runtime } = await makeProcessorState();
    const spaceB = (await Identity.fromPassphrase(
      "runtime-processor-space-b",
    )).did();
    const handleRuntimeSynced =
      (RuntimeProcessor.prototype as any).handleRuntimeSynced;
    try {
      processor.getSpaceCtx(spaceB);
      // Resolves across home + spaceB over loopback storage; the request
      // carries no space at all.
      await handleRuntimeSynced.call(processor);
    } finally {
      await runtime.dispose();
    }
  });

  it("watchSiteTable registers table entries, isolating bad ones", async () => {
    const { runtime } = createRuntime();
    const { siteTableCause, siteTableSchema } = await import(
      "@commonfabric/home-schemas"
    );
    const registered: Array<[string, string]> = [];
    Object.assign(runtime, {
      registerSpaceHost: (space: string, host: string) => {
        registered.push([space, host]);
        // Malformed hosts throw in the real registry — simulate to
        // assert per-entry isolation.
        if (host === "not a url") throw new Error("Invalid host");
        return host !== "http://refused.test/";
      },
    });
    const userDid = runtime.userIdentityDID;
    const table = runtime.getCell(
      userDid,
      siteTableCause(userDid),
      siteTableSchema,
    );
    const tx = runtime.edit();
    table.withTx(tx).set([
      { did: "did:key:z6Mk-table-a", host: "http://host-a.test/" },
      { did: "not-a-did", host: "http://ignored.test/" },
      { did: "did:key:z6Mk-table-bad", host: "not a url" },
      { did: "did:key:z6Mk-table-b", host: "http://refused.test/" },
      { did: "did:key:z6Mk-table-c", host: "http://host-c.test/" },
    ]);
    await tx.commit();

    const processor = { runtime } as unknown as RuntimeProcessor;
    try {
      (RuntimeProcessor.prototype as unknown as {
        watchSiteTable(): void;
      }).watchSiteTable.call(processor);
      await runtime.idle();
      // Microtask drain: sync() resolution + first sink fire.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(registered).toEqual([
        ["did:key:z6Mk-table-a", "http://host-a.test/"],
        ["did:key:z6Mk-table-bad", "not a url"],
        ["did:key:z6Mk-table-b", "http://refused.test/"],
        ["did:key:z6Mk-table-c", "http://host-c.test/"],
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it("handleRegisterSpaceHost forwards to the runtime and reports the verdict", () => {
    const calls: Array<[string, string]> = [];
    const processor = {
      runtime: {
        registerSpaceHost: (space: string, host: string) => {
          calls.push([space, host]);
          return host === "http://accepted.test/";
        },
      },
    } as unknown as RuntimeProcessor;
    const handle = (RuntimeProcessor.prototype as unknown as {
      handleRegisterSpaceHost(
        r: { type: RequestType; space: string; host: string },
      ): { value: boolean };
    }).handleRegisterSpaceHost;
    expect(handle.call(processor, {
      type: RequestType.RegisterSpaceHost,
      space: "did:key:z6Mk-ipc-a",
      host: "http://accepted.test/",
    })).toEqual({ value: true });
    expect(handle.call(processor, {
      type: RequestType.RegisterSpaceHost,
      space: "did:key:z6Mk-ipc-b",
      host: "http://refused.test/",
    })).toEqual({ value: false });
    expect(calls.length).toBe(2);
  });

  it("managerFor returns only existing contexts (no lazy create)", async () => {
    const { processor, runtime, homeSpace } = await makeProcessorState();
    const spaceB = (await Identity.fromPassphrase(
      "runtime-processor-space-b",
    )).did();
    const managerFor = (RuntimeProcessor.prototype as any).managerFor;
    try {
      expect(managerFor.call(processor, homeSpace)).toBe(
        processor.pieceManager,
      );
      expect(managerFor.call(processor, spaceB)).toBeUndefined();
      const ctxB = processor.getSpaceCtx(spaceB);
      expect(managerFor.call(processor, spaceB)).toBe(ctxB.pieceManager);
    } finally {
      await runtime.dispose();
    }
  });
});

// S16 phase D: the host's render confidentiality ceiling must reach every
// mount's reconciler — a ceiling configured at initialization that never
// arrives at the egress surface is silently unbounded rendering.
describe("RuntimeProcessor vdom mount render policy", () => {
  const handleVDomMount = (RuntimeProcessor.prototype as any).handleVDomMount;
  const handleVDomUnmount =
    (RuntimeProcessor.prototype as any).handleVDomUnmount;

  type RootRenderPolicy = {
    maxConfidentiality?: readonly unknown[];
    caveatKindAllow?: readonly string[];
  };

  async function mountAndGetRootPolicy(
    renderConfidentialityCeiling:
      | { atoms?: unknown[]; caveatKinds?: string[] }
      | undefined,
  ): Promise<RootRenderPolicy> {
    const { runtime } = createRuntime();
    const space = cfcSigner.did();
    const tx = runtime.edit();
    const cell = runtime.getCell<string>(
      space,
      "vdom-mount-render-policy",
      undefined,
      tx,
    );
    cell.set("hello");
    const commit = await tx.commit();
    expect(commit.ok !== undefined).toBe(true);

    const state = {
      runtime,
      vdomMounts: new Map<
        number,
        { reconciler: unknown; cancel: () => void }
      >(),
      vdomBatchIdCounter: 0,
      renderDeclassificationPolicy: "allow",
      renderConfidentialityCeiling,
      handleVDomUnmount,
    };
    // handleVDomMount's onOps/onError callbacks post to the worker scope;
    // stub postMessage for the main-thread test.
    const hadPostMessage = "postMessage" in globalThis;
    const originalPostMessage = (globalThis as any).postMessage;
    (globalThis as any).postMessage = () => {};
    try {
      handleVDomMount.call(state, {
        type: RequestType.VDomMount,
        mountId: 1,
        cell: cell.getAsNormalizedFullLink() as unknown as CellRef,
      });
      const mount = state.vdomMounts.get(1);
      expect(mount).toBeDefined();
      const policy = (mount!.reconciler as { rootRenderPolicy?: unknown })
        .rootRenderPolicy as RootRenderPolicy;
      handleVDomUnmount.call(state, {
        type: RequestType.VDomUnmount,
        mountId: 1,
      });
      return policy;
    } finally {
      // Reconciler flushes are queueMicrotask batches, so everything queued
      // by mount/unmount fires before this await's continuation — restoring
      // postMessage after it means the stub is in place through the last
      // flush, with no timer heuristics.
      await runtime.dispose();
      if (hadPostMessage) {
        (globalThis as any).postMessage = originalPostMessage;
      } else {
        delete (globalThis as any).postMessage;
      }
    }
  }

  it("threads the configured ceiling into each mount's reconciler", async () => {
    const userAtom = {
      type: "https://commonfabric.org/cfc/atom/Resource",
      class: "ActingUser",
      subject: cfcSigner.did(),
    };
    const caveatKind = "https://commonfabric.org/cfc/concepts/prompt-influence";
    const policy = await mountAndGetRootPolicy({
      atoms: [userAtom],
      caveatKinds: [caveatKind],
    });
    expect(policy.maxConfidentiality).toEqual([userAtom]);
    expect(policy.caveatKindAllow).toEqual([caveatKind]);
  });

  it("keeps mounts unbounded when no ceiling is configured", async () => {
    const policy = await mountAndGetRootPolicy(undefined);
    expect(policy.maxConfidentiality).toBeUndefined();
  });
});

describe("RuntimeProcessor cell set IPC", () => {
  const cellRef: CellRef = {
    id: "of:cell-set-retry" as CellRef["id"],
    space: "did:key:test-space" as CellRef["space"],
    scope: "space",
    path: ["nameDraft"],
  };

  type Deferred = {
    resolve: (r: { error?: { message: string } }) => void;
    promise: Promise<{ error?: { message: string } }>;
  };

  function makeProcessor(opts?: { editThrowsFirstN?: number }) {
    const setValues: unknown[] = [];
    const commits: Deferred[] = [];
    let editCalls = 0;
    const processor = {
      isDisposed: () => false,
      cellSetLatest: new Map<
        string,
        { seq: number; value: unknown; retriesLeft: number }
      >(),
      // The per-key commit queue: handleCellSet links same-key writes onto this
      // chain so their tx.commit() calls serialize (see the U3/supersede tests).
      cellSetChains: new Map<string, Promise<void>>(),
      // The chain links call this.commitLatestForKey; bind the real (private)
      // prototype method so the mock exercises the production loop, not a stub.
      commitLatestForKey: (RuntimeProcessor.prototype as unknown as {
        commitLatestForKey: (...a: unknown[]) => Promise<void>;
      }).commitLatestForKey,
      runtime: {
        edit: () => {
          // Inject a SYNCHRONOUS throw on the first N tx setups (simulates a
          // CFC-label violation / write-guard / malformed ref). commitLatestForKey
          // must catch this and resolve the link, not reject + wedge the chain.
          if (++editCalls <= (opts?.editThrowsFirstN ?? 0)) {
            throw new Error("synthetic tx-setup throw");
          }
          return {
            commit: () => {
              let resolve!: Deferred["resolve"];
              const promise = new Promise<{ error?: { message: string } }>(
                (res) => {
                  resolve = res;
                },
              );
              commits.push({ resolve, promise });
              return promise;
            },
          };
        },
        getCellFromLink: () => ({
          withTx: () => ({
            set: (value: unknown) => {
              setValues.push(value);
            },
          }),
        }),
        prepareTxForCommit: () => {},
      },
    } as unknown as RuntimeProcessor;
    const set = (value: string) =>
      RuntimeProcessor.prototype.handleCellSet.call(processor, {
        type: RequestType.CellSet,
        cell: cellRef,
        value,
      });
    return { processor, setValues, commits, set };
  }

  const flushAsync = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const REJECTED = { error: { message: "stale confirmed read: of:test" } };

  it("reapplies the latest value until a rejected commit lands", async () => {
    // U1 (preserved): a single key's commit, rejected twice, rebases each time
    // on a fresh tx and lands on the third. Under the per-key commit queue the
    // first link runs on a microtask (the chain's .then), so flush ONCE before
    // touching commits[0] — that is the only change from the pre-queue test;
    // the observable commit/set sequence is identical.
    const { setValues, commits, set } = makeProcessor();
    set("Bob");
    await flushAsync();
    commits[0].resolve(REJECTED);
    await flushAsync();
    commits[1].resolve(REJECTED);
    await flushAsync();
    commits[2].resolve({});
    await flushAsync();
    // Initial apply + two reapplies, each on a fresh tx.
    expect(setValues).toEqual(["Bob", "Bob", "Bob"]);
    expect(commits.length).toBe(3);
  });

  it("gives up after exhausting the bounded per-cell budget", async () => {
    // U2 (preserved): the rebase loop is bounded to CELL_SET_COMMIT_RETRIES.
    // Same one-microtask-later first link as U1, so flush before the loop reads
    // commits.length.
    const { setValues, commits, set } = makeProcessor();
    set("Bob");
    await flushAsync();
    for (let i = 0; i < 10 && i < commits.length; i++) {
      commits[i].resolve(REJECTED);
      await flushAsync();
    }
    // 1 initial + CELL_SET_COMMIT_RETRIES reapplies.
    expect(setValues.length).toBe(6);
  });

  it("serializes same-key writes: the 2nd commit is not issued until the 1st resolves", async () => {
    // U3 (NEW — the prevention property the after-the-fact reapply could not
    // provide). Two same-key sets are enqueued back-to-back. The queue links
    // them, so only ONE tx.commit() is in flight: the 2nd link cannot issue its
    // commit until the 1st link's commit resolves. This structurally forbids the
    // own-write race (two same-path patches overlapping, the 2nd confirming, the
    // 1st rejecting and rolling back past the confirmed value).
    const { processor, setValues, commits, set } = makeProcessor();
    set("B");
    set("Bob");
    await flushAsync();
    // THE PREVENTION PROPERTY: two same-key sets were enqueued, yet only ONE
    // tx.commit() is in flight. The 2nd link cannot issue its commit until the
    // 1st resolves — so the own-write race (two concurrent same-path commits,
    // one confirming while the other rejects-and-rolls-back) can never form.
    expect(commits.length).toBe(1);
    // Read-at-commit supersession: the in-flight link reads the LATEST value
    // ("Bob"), so the superseded "B" is never committed.
    expect(setValues).toEqual(["Bob"]);

    // Resolve the first commit successfully. ONLY NOW does the 2nd link run —
    // proving the serialization barrier. It re-commits the latest ("Bob", an
    // idempotent re-write) on its own fresh tx; still at most one in flight.
    commits[0].resolve({});
    await flushAsync();
    expect(commits.length).toBe(2);
    expect(setValues).toEqual(["Bob", "Bob"]);
    // Drain the 2nd link; the per-key maps clean up to bounded (empty) state.
    commits[1].resolve({});
    await flushAsync();
    const chains =
      (processor as unknown as { cellSetChains: Map<string, unknown> })
        .cellSetChains;
    const latest =
      (processor as unknown as { cellSetLatest: Map<string, unknown> })
        .cellSetLatest;
    expect(chains.size).toBe(0);
    expect(latest.size).toBe(0);
  });

  it("serializes same-identity writes even when schema/cfcLabelView differ", async () => {
    // Regression (cubic P2 on #4196): the queue keys on storage IDENTITY
    // (space:id:path), NOT the full cellRefToKey. Two writes to the SAME cell
    // whose refs carry DIFFERENT schema must still serialize onto ONE chain —
    // otherwise same-path writes could commit out of order again (the very race
    // this queue prevents). With the old schema-inclusive key these split into
    // two parallel chains and BOTH commits issue at once (commits.length === 2).
    const { processor, commits } = makeProcessor();
    const setWithSchema = (value: string, schema: unknown) =>
      RuntimeProcessor.prototype.handleCellSet.call(processor, {
        type: RequestType.CellSet,
        cell: { ...cellRef, schema } as CellRef,
        value,
      });
    setWithSchema("B", { type: "string" });
    setWithSchema("Bob", { type: "string", title: "name" }); // same id/path, diff schema
    await flushAsync();
    // Identity-keyed queue => ONE chain => at most one commit in flight.
    expect(commits.length).toBe(1);
    commits[0].resolve({});
    await flushAsync();
    expect(commits.length).toBe(2); // 2nd link runs only after the 1st resolves
    commits[1].resolve({});
    await flushAsync();
  });

  it("rebases to the LATEST value on a rejection, never a stale one", async () => {
    // U4 (re-pinned). The pre-queue test exercised TWO concurrent commits
    // (commits[1] resolving before commits[0]) to prove a late rollback of an
    // older write could not erase a newer confirmed one. Under serialization
    // that interleaving is structurally impossible to FORM (proven by U3), so
    // we re-pin to the residual rebase-correctness invariant the queue still
    // owns: when a commit is rejected, the rebase re-applies the LATEST value,
    // never the rejected-stale one. A SINGLE set keeps exactly one chain link so
    // the rebase loop is observed without a trailing idempotent re-commit.
    const { setValues, commits, set } = makeProcessor();
    set("B");
    set("Bob"); // supersedes "B" before the first link even commits
    await flushAsync();
    expect(setValues).toEqual(["Bob"]); // first commit already carries latest
    expect(commits.length).toBe(1);
    commits[0].resolve(REJECTED); // the (latest-valued) commit is rejected
    await flushAsync();
    // The rebase re-applies the LATEST value ("Bob"), never the superseded "B".
    expect(setValues).toEqual(["Bob", "Bob"]);
    // "B" was never committed at all — supersession dropped it before any tx.
    expect(setValues.includes("B")).toBe(false);
    // Land the rebase, then drain the trailing (2nd enqueued) link's idempotent
    // re-commit so the test leaves no pending microtasks.
    commits[1].resolve({});
    await flushAsync();
    commits[commits.length - 1].resolve({});
    await flushAsync();
    // Every committed value was the latest; no stale "B" ever reached a tx.
    expect(setValues.every((v) => v === "Bob")).toBe(true);
  });

  it("a newer set supersedes a pending write without spending retry budget", async () => {
    // U5 (re-pinned). The pre-queue test asserted a fixed interleaving
    // (["old","old","new","new"]) that was an artifact of two racing chains.
    // Under the serialized queue the invariant — not a fixed array — is the
    // contract: the final landed value is the LATEST input, no value older than
    // the latest is ever written after it, and a supersession does NOT consume
    // the rebase budget (seq-skip).
    const { processor, setValues, commits, set } = makeProcessor();
    set("old");
    await flushAsync();
    expect(setValues).toEqual(["old"]);
    // A newer set arrives while "old"'s commit is in flight (commits[0]). It
    // bumps seq and refreshes budget; the in-flight link reads it on rejection.
    set("new");
    commits[0].resolve(REJECTED); // the "old" commit fails
    await flushAsync();
    // The rejection was for a SUPERSEDED seq, so the loop rebased to "new"
    // WITHOUT decrementing budget. Land it.
    const newIdx = setValues.lastIndexOf("new");
    expect(newIdx).toBeGreaterThanOrEqual(0);
    // Invariant: no "old" written after the first "new".
    expect(setValues.slice(newIdx).includes("old")).toBe(false);
    // Discriminator for the seq-skip optimization itself: the in-flight "new"
    // entry must still hold FULL budget — the superseded rejection consumed
    // none. (If the seq-skip were broken and decremented on supersession, this
    // would read CELL_SET_COMMIT_RETRIES - 1.)
    // deno-lint-ignore no-explicit-any
    const entry = [...(processor as any).cellSetLatest.values()][0];
    expect(entry?.retriesLeft).toBe(5); // CELL_SET_COMMIT_RETRIES, undecremented
    commits[commits.length - 1].resolve({});
    await flushAsync();
    expect(setValues.at(-1)).toBe("new");
  });

  it("stops issuing commits after dispose mid-flight", async () => {
    // Dispose while a commit is unresolved: no further tx.commit() is issued
    // (the loop short-circuits on isDisposed() at each boundary, and dispose
    // clears the queue maps). The in-flight commit is left to settle under the
    // existing storageManager.synced() await in the real dispose(); here we just
    // resolve it as rejected and confirm no rebase follows.
    const { processor, setValues, commits, set } = makeProcessor();
    set("Bob");
    await flushAsync();
    expect(commits.length).toBe(1);
    // Simulate disposal: flip the flag and clear the queue, mirroring dispose().
    (processor as unknown as { isDisposed: () => boolean }).isDisposed = () =>
      true;
    (processor as unknown as { cellSetChains: Map<string, unknown> })
      .cellSetChains.clear();
    (processor as unknown as { cellSetLatest: Map<string, unknown> })
      .cellSetLatest.clear();
    const before = commits.length;
    commits[0].resolve(REJECTED); // would normally trigger a rebase
    await flushAsync();
    // No new commit was issued after disposal.
    expect(commits.length).toBe(before);
    expect(setValues).toEqual(["Bob"]);
  });

  it("a synchronous tx-setup throw resolves the link and frees the key (no wedge, no unhandled rejection)", async () => {
    // Regression for the widened try in commitLatestForKey: a SYNCHRONOUS throw
    // from edit()/set()/prepareTxForCommit() (a CFC-label violation, write-guard
    // or malformed ref — exactly the op-types this queue serializes) must be
    // caught so the link RESOLVES, not rejects. Without the widened try, the
    // chain's `.then` carries an unhandled rejection (deno fails the test) AND
    // the next same-key write wedges (its commit is never issued).
    const { setValues, commits, set } = makeProcessor({ editThrowsFirstN: 1 });
    set("a"); // first link: edit() throws synchronously, before any commit
    await flushAsync();
    expect(commits.length).toBe(0); // nothing committed; link resolved cleanly
    // The key is freed: a subsequent same-key write still commits and lands.
    set("b");
    await flushAsync();
    expect(commits.length).toBe(1); // chain NOT wedged — "b" issued its commit
    commits[0].resolve({});
    await flushAsync();
    expect(setValues.at(-1)).toBe("b");
  });
});
