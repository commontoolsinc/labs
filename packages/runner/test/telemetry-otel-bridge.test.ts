import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type {
  Attributes,
  Meter,
  Span,
  SpanOptions,
  Tracer,
} from "@opentelemetry/api";
import {
  attachRuntimeTelemetryOtelBridge,
  createRuntimeTelemetryOtelBridge,
} from "../src/telemetry-otel-bridge.ts";
import {
  type HostRuntimeTelemetryMarker,
  RuntimeTelemetry,
  RuntimeTelemetryEvent,
  type RuntimeTelemetryMarkerResult,
} from "../src/telemetry.ts";

// ---------------------------------------------------------------------------
// Hand-rolled recording fakes for the OTel API interfaces. The bridge only
// depends on `@opentelemetry/api` (interfaces), so tests don't need the SDK:
// we record every instrument call and assert on the translation directly.
// ---------------------------------------------------------------------------

interface InstrumentCall {
  instrument: string;
  value: number;
  attributes?: Attributes;
}

interface SpanRecord {
  name: string;
  attributes: Attributes;
  setAttributes: Attributes;
  status?: { code: number; message?: string };
  ended: boolean;
  startTime?: number;
  endTime?: number;
}

function makeRecordingMeter(): { meter: Meter; calls: InstrumentCall[] } {
  const calls: InstrumentCall[] = [];
  const record =
    (instrument: string) => (value: number, attributes?: Attributes) => {
      calls.push({ instrument, value, attributes });
    };
  const meter = {
    createCounter: (name: string) => ({ add: record(name) }),
    createUpDownCounter: (name: string) => ({ add: record(name) }),
    createHistogram: (name: string) => ({ record: record(name) }),
  } as unknown as Meter;
  return { meter, calls };
}

function makeRecordingTracer(): { tracer: Tracer; spans: SpanRecord[] } {
  const spans: SpanRecord[] = [];
  const tracer = {
    startSpan(name: string, options?: SpanOptions): Span {
      const rec: SpanRecord = {
        name,
        attributes: (options?.attributes ?? {}) as Attributes,
        setAttributes: {},
        ended: false,
        startTime: options?.startTime as number | undefined,
      };
      spans.push(rec);
      return {
        setAttribute(key: string, value: unknown) {
          rec.setAttributes[key] = value as Attributes[string];
          return this;
        },
        setStatus(status: { code: number; message?: string }) {
          rec.status = status;
          return this;
        },
        end(endTime?: number) {
          rec.ended = true;
          rec.endTime = endTime as number | undefined;
        },
      } as unknown as Span;
    },
  } as unknown as Tracer;
  return { tracer, spans };
}

function marker(
  partial: Record<string, unknown>,
): RuntimeTelemetryMarkerResult {
  return {
    id: "m-1",
    timestamp: 0,
    ...partial,
  } as unknown as RuntimeTelemetryMarkerResult;
}

describe("createRuntimeTelemetryOtelBridge", () => {
  let meterCalls: InstrumentCall[];
  let spans: SpanRecord[];
  let bridge: ReturnType<typeof createRuntimeTelemetryOtelBridge>;

  const setup = (options: {
    attributes?: Attributes;
    metricAttributes?: Attributes;
    spanAttributes?: Attributes;
  } = {}) => {
    const m = makeRecordingMeter();
    const t = makeRecordingTracer();
    meterCalls = m.calls;
    spans = t.spans;
    bridge = createRuntimeTelemetryOtelBridge({
      tracer: t.tracer,
      meter: m.meter,
      ...options,
    });
  };

  beforeEach(() => setup());

  it("counts scheduler runs with pattern and error attributes", () => {
    bridge.handleMarker(marker({
      type: "scheduler.run",
      actionInfo: { patternName: "lunch-poll", moduleName: "vote" },
      error: "boom",
    }));
    expect(meterCalls).toEqual([{
      instrument: "ct.scheduler.runs",
      value: 1,
      attributes: {
        "ct.pattern": "lunch-poll",
        "ct.module": "vote",
        "ct.error": true,
      },
    }]);
  });

  it("records commit amplification and counts every scheduled retry", () => {
    bridge.handleMarker(marker({
      type: "scheduler.event.commit",
      eventId: "evt:private:0:of:stream",
      readCount: 6,
      writeCount: 7,
      changedWriteCount: 4,
      retryAttempt: 1,
      backoffMs: 1,
    }));
    expect(meterCalls.map((c) => c.instrument)).toEqual([
      "ct.scheduler.commits",
      "ct.scheduler.commit.writes",
      "ct.scheduler.commit.changed_writes",
      "ct.scheduler.commit.noop_candidate_writes",
      "ct.scheduler.commit.reads",
      "ct.scheduler.commit.retries",
    ]);
    expect(meterCalls[1].value).toBe(7);
    expect(meterCalls[2].value).toBe(4);
    expect(meterCalls[3].value).toBe(3);
    expect(meterCalls[4].value).toBe(6);
    for (const call of meterCalls) {
      expect(call.attributes?.eventId).toBeUndefined();
      expect(call.attributes?.["ct.event_id"]).toBeUndefined();
    }

    meterCalls.length = 0;
    bridge.handleMarker(marker({
      type: "scheduler.event.commit",
      readCount: 1,
      writeCount: 2,
      changedWriteCount: 2,
      retryAttempt: 3,
      terminal: "convergence",
    }));
    expect(meterCalls.map((c) => c.instrument)).toEqual([
      "ct.scheduler.commits",
      "ct.scheduler.commit.writes",
      "ct.scheduler.commit.changed_writes",
      "ct.scheduler.commit.noop_candidate_writes",
      "ct.scheduler.commit.reads",
    ]);
    expect(meterCalls[0].attributes?.["ct.commit.terminal"]).toBe(
      "convergence",
    );
  });

  it("records every preflight phase and a retroactive span", () => {
    bridge.handleMarker(marker({
      type: "scheduler.event.preflight",
      handlerId: "h-1",
      populateMs: 1,
      txToLogMs: 2,
      depCommitMs: 3,
      collectMs: 4,
      scheduleMs: 5,
      readCount: 10,
      shallowReadCount: 6,
      dirtyDependencyCount: 7,
      stats: {
        maxDepth: 2,
        workSetAddCount: 8,
        reverseDependencyEdgeCount: 9,
      },
    }));
    const names = meterCalls.map((c) => c.instrument);
    expect(names).toEqual([
      "ct.scheduler.preflight.populate_ms",
      "ct.scheduler.preflight.tx_to_log_ms",
      "ct.scheduler.preflight.dep_commit_ms",
      "ct.scheduler.preflight.collect_ms",
      "ct.scheduler.preflight.schedule_ms",
      "ct.scheduler.preflight.total_ms",
      "ct.scheduler.preflight.dirty_dependency_count",
    ]);
    // total = sum of phases
    expect(meterCalls[5].value).toBe(15);
    // retroactive span reconstructs its window from the total
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("scheduler.preflight");
    expect(spans[0].ended).toBe(true);
    expect(spans[0].endTime! - spans[0].startTime!).toBe(15);
    expect(spans[0].attributes["ct.handler_id"]).toBe("h-1");
  });

  it("opens a span on storage push start and closes it on complete", () => {
    bridge.handleMarker(marker({
      id: "op-1",
      type: "storage.push.start",
      operation: "send",
    }));
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("storage.push");
    expect(spans[0].ended).toBe(false);

    bridge.handleMarker(marker({ id: "op-1", type: "storage.push.complete" }));
    expect(spans[0].ended).toBe(true);
    expect(spans[0].status).toBeUndefined();
    const ops = meterCalls.filter((c) => c.instrument === "ct.storage.ops");
    expect(ops).toHaveLength(1);
    expect(ops[0].attributes?.["ct.storage.error"]).toBe(false);
    expect(
      meterCalls.some((c) => c.instrument === "ct.storage.op.duration_ms"),
    ).toBe(true);
  });

  it("marks a storage pull error span as errored", () => {
    bridge.handleMarker(marker({
      id: "op-2",
      type: "storage.pull.start",
      operation: "sync",
    }));
    bridge.handleMarker(marker({
      id: "op-2",
      type: "storage.pull.error",
      error: "connection reset",
    }));
    expect(spans[0].ended).toBe(true);
    expect(spans[0].status?.message).toBe("connection reset");
    expect(spans[0].setAttributes["error"]).toBe(true);
    const ops = meterCalls.filter((c) => c.instrument === "ct.storage.ops");
    expect(ops[0].attributes?.["ct.storage.error"]).toBe(true);
  });

  it("tracks subscriptions up and down and connection updates", () => {
    bridge.handleMarker(marker({ type: "storage.subscription.add" }));
    bridge.handleMarker(marker({ type: "storage.subscription.remove" }));
    bridge.handleMarker(marker({
      type: "storage.connection.update",
      status: "connected",
      attempt: 2,
    }));
    expect(meterCalls).toEqual([
      { instrument: "ct.storage.subscriptions", value: 1, attributes: {} },
      { instrument: "ct.storage.subscriptions", value: -1, attributes: {} },
      {
        instrument: "ct.storage.connection.updates",
        value: 1,
        attributes: {
          "ct.connection.status": "connected",
          "ct.connection.attempt": 2,
        },
      },
    ]);
  });

  it("records non-settling windows as busy ratio + counter", () => {
    bridge.handleMarker(marker({
      type: "scheduler.non-settling",
      busyRatio: 0.75,
    }));
    expect(meterCalls).toEqual([
      { instrument: "ct.scheduler.busy_ratio", value: 0.75, attributes: {} },
      {
        instrument: "ct.scheduler.non_settling.events",
        value: 1,
        attributes: {},
      },
    ]);
  });

  it("ignores debug-view-only markers", () => {
    bridge.handleMarker(marker({ type: "scheduler.dependencies.update" }));
    bridge.handleMarker(marker({ type: "scheduler.graph.snapshot" }));
    bridge.handleMarker(marker({ type: "scheduler.subscribe" }));
    expect(meterCalls).toHaveLength(0);
    expect(spans).toHaveLength(0);
  });

  it("records aggregate host markers without creating detailed spans", () => {
    const stats = {
      visitCount: 1,
      dirtyInputCount: 2,
      resultTrueCount: 3,
      workSetAddCount: 4,
      reverseDependencyActionCount: 5,
      reverseDependencyEdgeCount: 6,
      logReadCount: 7,
      logShallowReadCount: 8,
      writerCandidateCount: 9,
      writerOverlapCount: 10,
      directWriterCount: 11,
      hotActionCount: 12,
      hotFanoutActionCount: 13,
      rootDirectWriterCount: 14,
    };
    const markers = [
      { type: "scheduler.run", timeStamp: 1, ok: false },
      { type: "cell.update", timeStamp: 1 },
      { type: "scheduler.invocation", timeStamp: 1, ok: false },
      {
        type: "scheduler.run.complete",
        timeStamp: 1,
        durationMs: 20,
        ok: false,
      },
      {
        type: "scheduler.settle",
        timeStamp: 1,
        durationMs: 21,
        iterations: 2,
        settledEarly: false,
        seedCount: 3,
        workSetSize: 4,
      },
      {
        type: "scheduler.event.commit",
        timeStamp: 1,
        readCount: 5,
        writeCount: 6,
        changedWriteCount: 4,
        ok: false,
        backoffMs: 7,
        terminal: "rule",
      },
      {
        type: "scheduler.event.preflight",
        timeStamp: 1,
        readCount: 1,
        shallowReadCount: 2,
        dirtySizeBefore: 3,
        pendingSizeBefore: 4,
        dirtyDependencyCount: 5,
        hasDirtyDependencies: true,
        skipped: false,
        populateMs: 6,
        txToLogMs: 7,
        depCommitMs: 8,
        collectMs: 9,
        scheduleMs: 10,
        stats,
        ok: false,
      },
      {
        type: "scheduler.non-settling",
        timeStamp: 1,
        busyTime: 2,
        windowDuration: 3,
        busyRatio: 0.75,
      },
      {
        type: "storage.connection.update",
        timeStamp: 1,
        status: "error",
        attempt: 2,
        ok: false,
      },
      { type: "storage.subscription.add", timeStamp: 1, ok: false },
      { type: "storage.subscription.remove", timeStamp: 1, ok: false },
    ] satisfies HostRuntimeTelemetryMarker[];

    for (const hostMarker of markers) bridge.handleMarker(hostMarker);

    expect(meterCalls.map((call) => call.instrument)).toEqual([
      "ct.scheduler.runs",
      "ct.cell.updates",
      "ct.scheduler.invocations",
      "ct.scheduler.action.duration_ms",
      "ct.scheduler.settle.duration_ms",
      "ct.scheduler.settle.iterations",
      "ct.scheduler.commits",
      "ct.scheduler.commit.writes",
      "ct.scheduler.commit.changed_writes",
      "ct.scheduler.commit.noop_candidate_writes",
      "ct.scheduler.commit.reads",
      "ct.scheduler.commit.retries",
      "ct.scheduler.preflight.populate_ms",
      "ct.scheduler.preflight.tx_to_log_ms",
      "ct.scheduler.preflight.dep_commit_ms",
      "ct.scheduler.preflight.collect_ms",
      "ct.scheduler.preflight.schedule_ms",
      "ct.scheduler.preflight.total_ms",
      "ct.scheduler.preflight.dirty_dependency_count",
      "ct.scheduler.busy_ratio",
      "ct.scheduler.non_settling.events",
      "ct.storage.connection.updates",
      "ct.storage.subscriptions",
      "ct.storage.subscriptions",
    ]);
    expect(meterCalls[0].attributes).toEqual({ "ct.error": true });
    expect(meterCalls[3].attributes).toEqual({ "ct.error": true });
    expect(meterCalls[6].attributes).toEqual({
      "ct.commit.terminal": "rule",
      "ct.error": true,
    });
    expect(meterCalls[16].value).toBe(10);
    expect(meterCalls[17].value).toBe(40);
    expect(meterCalls[21].attributes).toEqual({
      "ct.connection.status": "error",
      "ct.connection.attempt": 2,
    });
    expect(spans).toHaveLength(0);
  });

  it("ignores host-only marker types across every discriminator family", () => {
    const ignored = [
      { type: "scheduler.event.drop", timeStamp: 1, reason: "preflight" },
      {
        type: "scheduler.graph.snapshot",
        timeStamp: 1,
        nodeCount: 2,
        edgeCount: 3,
      },
      { type: "scheduler.subscribe", timeStamp: 1, isEffect: true },
      {
        type: "scheduler.dependencies.update",
        timeStamp: 1,
        readCount: 2,
        writeCount: 3,
      },
      { type: "storage.push.start", timeStamp: 1, ok: false },
      { type: "storage.push.complete", timeStamp: 1, ok: false },
      { type: "storage.push.error", timeStamp: 1, ok: false },
      { type: "storage.pull.start", timeStamp: 1, ok: false },
      { type: "storage.pull.complete", timeStamp: 1, ok: false },
      { type: "storage.pull.error", timeStamp: 1, ok: false },
    ] satisfies HostRuntimeTelemetryMarker[];

    for (const hostMarker of ignored) bridge.handleMarker(hostMarker);

    expect(meterCalls).toHaveLength(0);
    expect(spans).toHaveLength(0);
  });

  it("ignores detailed event drops with private event IDs", () => {
    bridge.handleMarker(marker({
      type: "scheduler.event.drop",
      eventId: "evt:private:0:of:stream",
      reason: "preflight",
    }));

    expect(meterCalls).toHaveLength(0);
    expect(spans).toHaveLength(0);
  });

  it("stamps base attributes on spans and metrics alike", () => {
    setup({ attributes: { "user.did": "did:key:alice" } });
    bridge.handleMarker(marker({ type: "cell.update" }));
    bridge.handleMarker(marker({
      id: "op-3",
      type: "storage.push.start",
      operation: "send",
    }));
    expect(meterCalls[0].attributes?.["user.did"]).toBe("did:key:alice");
    expect(spans[0].attributes["user.did"]).toBe("did:key:alice");
  });

  it("stamps metricAttributes on metrics but never on spans", () => {
    setup({
      attributes: { "user.did": "did:key:alice" },
      metricAttributes: { "service.name": "bg-piece-service" },
    });
    bridge.handleMarker(marker({ type: "cell.update" }));
    bridge.handleMarker(marker({
      id: "op-4",
      type: "storage.push.start",
      operation: "send",
    }));
    expect(meterCalls[0].attributes).toEqual({
      "user.did": "did:key:alice",
      "service.name": "bg-piece-service",
    });
    // span keeps resource-style keys off its attributes (SigNoz treats a key
    // present in both resource and attribute context as ambiguous)
    expect(spans[0].attributes["service.name"]).toBeUndefined();
    expect(spans[0].attributes["user.did"]).toBe("did:key:alice");
  });

  it("stamps span-only attributes on spans but never metrics", () => {
    setup({
      attributes: { "ct.runtime": "harness" },
      spanAttributes: { "user.did": "did:key:alice" },
    });
    bridge.handleMarker(marker({ type: "cell.update" }));
    bridge.handleMarker(marker({
      id: "op-span-only",
      type: "storage.push.start",
      operation: "send",
    }));
    expect(meterCalls[0].attributes).toEqual({ "ct.runtime": "harness" });
    expect(spans[0].attributes).toEqual({
      "ct.runtime": "harness",
      "user.did": "did:key:alice",
      "ct.storage.kind": "push",
      "ct.storage.operation": "send",
    });
  });

  it("attributes every commit histogram with pattern attribution", () => {
    bridge.handleMarker(marker({
      type: "scheduler.event.commit",
      readCount: 2,
      writeCount: 3,
      changedWriteCount: 1,
      handlerInfo: { patternName: "topics", moduleName: "topic" },
    }));
    for (const call of meterCalls) {
      expect(call.attributes?.["ct.pattern"]).toBe("topics");
      expect(call.attributes?.["ct.module"]).toBe("topic");
    }
  });

  it("closes in-flight storage spans on shutdown", () => {
    bridge.handleMarker(marker({
      id: "op-5",
      type: "storage.pull.start",
      operation: "sync",
    }));
    expect(spans[0].ended).toBe(false);
    bridge.shutdown();
    expect(spans[0].ended).toBe(true);
  });
});

describe("scheduler.run.complete / scheduler.settle / storage join keys", () => {
  it("records action duration and emits a span only at/above the threshold", () => {
    const m = makeRecordingMeter();
    const t = makeRecordingTracer();
    const bridge = createRuntimeTelemetryOtelBridge({
      tracer: t.tracer,
      meter: m.meter,
    });

    bridge.handleMarker(marker({
      type: "scheduler.run.complete",
      actionId: "hash:1",
      actionInfo: { patternName: "lunch-poll", moduleName: "tally" },
      durationMs: 2,
    }));
    expect(m.calls).toEqual([{
      instrument: "ct.scheduler.action.duration_ms",
      value: 2,
      attributes: {
        "ct.pattern": "lunch-poll",
        "ct.module": "tally",
        "ct.error": false,
      },
    }]);
    expect(t.spans).toHaveLength(0);

    bridge.handleMarker(marker({
      type: "scheduler.run.complete",
      actionId: "hash:2",
      actionInfo: { patternName: "lunch-poll", moduleName: "tally" },
      durationMs: 25,
      error: "boom",
    }));
    expect(t.spans).toHaveLength(1);
    expect(t.spans[0].name).toBe("scheduler.action.run");
    expect(t.spans[0].attributes["ct.action_id"]).toBe("hash:2");
    expect(t.spans[0].attributes["ct.duration_ms"]).toBe(25);
    expect(t.spans[0].status?.message).toBe("boom");
    expect(t.spans[0].ended).toBe(true);
    // Retroactive: reconstructed window ≈ durationMs wide.
    expect(
      (t.spans[0].endTime ?? 0) - (t.spans[0].startTime ?? 0),
    ).toBe(25);
  });

  it("honors a custom action-run span threshold", () => {
    const m = makeRecordingMeter();
    const t = makeRecordingTracer();
    const bridge = createRuntimeTelemetryOtelBridge({
      tracer: t.tracer,
      meter: m.meter,
      actionRunSpanThresholdMs: 100,
    });
    bridge.handleMarker(marker({
      type: "scheduler.run.complete",
      actionId: "hash:3",
      durationMs: 50,
    }));
    expect(t.spans).toHaveLength(0);
  });

  it("records settle duration and iterations histograms", () => {
    const m = makeRecordingMeter();
    const t = makeRecordingTracer();
    const bridge = createRuntimeTelemetryOtelBridge({
      tracer: t.tracer,
      meter: m.meter,
    });
    bridge.handleMarker(marker({
      type: "scheduler.settle",
      durationMs: 120,
      iterations: 3,
      settledEarly: false,
      seedCount: 5,
      workSetSize: 12,
    }));
    expect(m.calls).toEqual([
      { instrument: "ct.scheduler.settle.duration_ms", value: 120 },
      { instrument: "ct.scheduler.settle.iterations", value: 3 },
    ].map((c) => ({ ...c, attributes: {} })));
  });

  it("stamps commit.local_seq and space.did on storage.push spans", () => {
    const m = makeRecordingMeter();
    const t = makeRecordingTracer();
    const bridge = createRuntimeTelemetryOtelBridge({
      tracer: t.tracer,
      meter: m.meter,
    });
    bridge.handleMarker(marker({
      id: "push:did:key:zX:7",
      type: "storage.push.start",
      operation: "transact",
      localSeq: 7,
      spaceDid: "did:key:zX",
    }));
    expect(t.spans[0].attributes["commit.local_seq"]).toBe(7);
    expect(t.spans[0].attributes["space.did"]).toBe("did:key:zX");
    bridge.handleMarker(marker({
      id: "push:did:key:zX:7",
      type: "storage.push.complete",
      sessionId: "session-a",
    }));
    expect(t.spans[0].setAttributes["session.id"]).toBe("session-a");
    expect(t.spans[0].ended).toBe(true);

    // Error half: the rejected-commit span keeps the same join keys and
    // carries the rejection name.
    bridge.handleMarker(marker({
      id: "push:did:key:zX:8",
      type: "storage.push.start",
      operation: "transact",
      localSeq: 8,
      spaceDid: "did:key:zX",
    }));
    bridge.handleMarker(marker({
      id: "push:did:key:zX:8",
      type: "storage.push.error",
      sessionId: "session-a",
      error: "ConflictError",
    }));
    expect(t.spans[1].setAttributes["session.id"]).toBe("session-a");
    expect(t.spans[1].status?.message).toBe("ConflictError");
    expect(t.spans[1].ended).toBe(true);
  });
});

describe("attachRuntimeTelemetryOtelBridge", () => {
  it("retains detailed event commit telemetry until detached", () => {
    const m = makeRecordingMeter();
    const t = makeRecordingTracer();
    const telemetry = new RuntimeTelemetry();
    const retainedElsewhere = telemetry.retainDetailedEventCommitTelemetry();

    const detach = attachRuntimeTelemetryOtelBridge(telemetry, {
      tracer: t.tracer,
      meter: m.meter,
    });
    expect(telemetry.detailedEventCommitTelemetryEnabled).toBe(true);

    retainedElsewhere();
    expect(telemetry.detailedEventCommitTelemetryEnabled).toBe(true);
    detach();
    expect(telemetry.detailedEventCommitTelemetryEnabled).toBe(false);
    detach();
    expect(telemetry.detailedEventCommitTelemetryEnabled).toBe(false);
  });

  it("feeds telemetry events through the bridge until detached", () => {
    const m = makeRecordingMeter();
    const t = makeRecordingTracer();
    const telemetry = new EventTarget();
    const detach = attachRuntimeTelemetryOtelBridge(telemetry, {
      tracer: t.tracer,
      meter: m.meter,
    });

    telemetry.dispatchEvent(
      new RuntimeTelemetryEvent(marker({ type: "cell.update" })),
    );
    expect(m.calls).toHaveLength(1);

    detach();
    telemetry.dispatchEvent(
      new RuntimeTelemetryEvent(marker({ type: "cell.update" })),
    );
    expect(m.calls).toHaveLength(1);
  });

  it("closes in-flight spans when detached", () => {
    const m = makeRecordingMeter();
    const t = makeRecordingTracer();
    const telemetry = new EventTarget();
    const detach = attachRuntimeTelemetryOtelBridge(telemetry, {
      tracer: t.tracer,
      meter: m.meter,
    });
    telemetry.dispatchEvent(
      new RuntimeTelemetryEvent(
        marker({ id: "op-6", type: "storage.push.start", operation: "send" }),
      ),
    );
    expect(t.spans[0].ended).toBe(false);
    detach();
    expect(t.spans[0].ended).toBe(true);
  });
});
