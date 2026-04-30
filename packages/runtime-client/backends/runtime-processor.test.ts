import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
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
import { cellRefToSigilLink } from "./utils.ts";

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

describe("RuntimeProcessor CFC label IPC", () => {
  it("returns a label view for a cell ref", async () => {
    const ref: CellRef = {
      id: "of:cfc-label-cell" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      type: "application/json",
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
          getSourceCell: () => undefined,
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

  it("returns label views on resolved cell refs", () => {
    const sourceRef: CellRef = {
      id: "of:cfc-label-source" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      type: "application/json",
      path: [],
    };
    const resolvedRef: CellRef = {
      id: "of:cfc-label-resolved" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      type: "application/json",
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

  it("does not look up CFC labels from a result cell source", async () => {
    const resultRef: CellRef = {
      id: "of:cfc-label-result" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      type: "application/json",
      path: [],
    };
    const sourceRef: CellRef = {
      id: "of:cfc-label-source" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      type: "application/json",
      path: [],
    };
    let resultSynced = false;
    let sourceSynced = false;
    const runtime = {
      readTx: () => ({
        readOrThrow: (address: { id: string }) =>
          address.id === sourceRef.id
            ? {
              value: "process cell",
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
      getCellFromLink: () => resultCell,
    };
    const sourceCell = {
      runtime,
      getAsNormalizedFullLink: () => sourceRef,
      getSourceCell: () => undefined,
      sync: () => {
        sourceSynced = true;
        return Promise.resolve();
      },
    };
    const resultCell = {
      runtime,
      getAsNormalizedFullLink: () => resultRef,
      getSourceCell: () => resultSynced ? sourceCell : undefined,
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
    expect(sourceSynced).toBe(true);
  });
});

describe("RuntimeProcessor CFC commit preparation", () => {
  const ref: CellRef = {
    id: "of:cfc-client-write" as CellRef["id"],
    space: "did:key:test" as CellRef["space"],
    type: "application/json",
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
    return {
      processor: {
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
    };
  };

  it("prepares cell set transactions before committing", async () => {
    const { processor } = createProcessor();

    await RuntimeProcessor.prototype.handleCellSet.call(processor, {
      type: RequestType.CellSet,
      cell: ref,
      value: "new value",
    });
  });

  it("prepares cell send transactions before committing", async () => {
    const { processor } = createProcessor();

    await RuntimeProcessor.prototype.handleCellSend.call(processor, {
      type: RequestType.CellSend,
      cell: ref,
      event: "new value",
    });
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
      type: "application/json",
      path: ["value"],
      cfcLabelView,
    };

    expect(cellRefToSigilLink(ref)).toEqual({
      "/": {
        "link@1": {
          id: ref.id,
          space: ref.space,
          type: ref.type,
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
      undefined,
    );

    expect(options.cfcEnforcementMode).toBe("enforce-explicit");
    expect(options.trustSnapshotProvider?.()).toEqual({
      id: "principal:did:key:worker",
      actingPrincipal: "did:key:worker",
    });
  });
});
