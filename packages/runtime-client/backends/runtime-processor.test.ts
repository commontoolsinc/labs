import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  RuntimeProcessor,
  sanitizeForPostMessage,
} from "./runtime-processor.ts";
import { RequestType } from "../protocol/mod.ts";

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
