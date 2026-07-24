// OpenTelemetry bridge for runtime telemetry at two privacy levels.
//
// Worker/server callers feed detailed RuntimeTelemetry markers from the
// RuntimeTelemetry EventTarget. Browser hosts feed HostRuntimeTelemetryMarker,
// the aggregate-only projection received over the worker-to-host boundary.
// Detailed markers can supply diagnostic span attributes; host markers produce
// only metrics available from their safe aggregate fields.
//
// It depends ONLY on `@opentelemetry/api` (interface-only, side-effect free), so
// importing it never pulls the OTel SDK into a bundle and never forces
// `--allow-sys`. Each host (background-piece-service, toolshed, browser shell)
// owns its SDK provider setup and passes a Tracer + Meter in. When no provider
// is registered the API returns no-op instruments, so the bridge is inert.
//
// Reuse across runtimes: the worker/server side exposes `runtime.telemetry`,
// while the browser host receives its sanitized projection through
// `runtime-client.on("telemetry", ...)`. `handleMarker()` selects the detailed
// or aggregate translator without widening the worker-to-host payload.

import {
  type Attributes,
  type Meter,
  type Span,
  SpanStatusCode,
  type Tracer,
} from "@opentelemetry/api";
import type {
  HostRuntimeTelemetryMarker,
  RuntimeTelemetry,
  RuntimeTelemetryEvent,
  RuntimeTelemetryMarkerResult,
} from "./telemetry.ts";

export interface OtelBridgeOptions {
  tracer: Tracer;
  meter: Meter;
  /**
   * Attributes stamped on every emitted span and metric — the dimensions the
   * markers themselves don't carry. Set here once at attach time from the host's
   * host context, e.g. `{ "ct.runtime": "bg-piece" }`. Put high-cardinality
   * identity dimensions in `spanAttributes` instead.
   */
  attributes?: Attributes;
  /**
   * Attributes stamped on SPANS ONLY, merged over `attributes`. Use for trace
   * pivots such as identities that would create excessive metric cardinality.
   */
  spanAttributes?: Attributes;
  /**
   * Attributes stamped on METRICS ONLY, merged over `attributes`. Backends
   * don't map OTel resource attributes onto metric datapoint labels, so pass
   * service.name / deployment.environment here to make metrics scopable by
   * service and environment. Kept off spans deliberately: spans already carry
   * these on their resource, and duplicating them as span attributes makes the
   * bare key ambiguous (resource vs attribute context) in SigNoz queries.
   */
  metricAttributes?: Attributes;
  /**
   * Minimum action-run duration that earns a retroactive `scheduler.action.run`
   * span. Measured on the lunch-poll diagnose workload: ~4.4% of runs exceed
   * 10ms (the distribution is bimodal — sub-ms computations vs 10–25ms
   * effects), so the default adds ~5% span volume, not a multiplier. Every run
   * still lands in the `ct.scheduler.action.duration_ms` histogram.
   * @default 10
   */
  actionRunSpanThresholdMs?: number;
}

export interface RuntimeTelemetryOtelBridge {
  /** Translate a detailed runtime or aggregate-safe host marker into telemetry. */
  handleMarker(
    marker: HostRuntimeTelemetryMarker | RuntimeTelemetryMarkerResult,
  ): void;
  /** Close any spans still open (e.g. storage ops without a completion). */
  shutdown(): void;
}

/**
 * Attach a bridge directly to a RuntimeTelemetry EventTarget (worker/server
 * side). Returns a detach function that removes the listener and closes any
 * in-flight spans.
 */
export function attachRuntimeTelemetryOtelBridge(
  telemetry:
    & EventTarget
    & Partial<Pick<RuntimeTelemetry, "retainDetailedEventCommitTelemetry">>,
  options: OtelBridgeOptions,
): () => void {
  const bridge = createRuntimeTelemetryOtelBridge(options);
  const releaseDetailedEventCommitTelemetry = telemetry
    .retainDetailedEventCommitTelemetry?.();
  const listener = (event: Event) => {
    bridge.handleMarker((event as RuntimeTelemetryEvent).marker);
  };
  telemetry.addEventListener("telemetry", listener);
  return () => {
    telemetry.removeEventListener("telemetry", listener);
    bridge.shutdown();
    releaseDetailedEventCommitTelemetry?.();
  };
}

/**
 * Create a bridge for detailed EventTarget markers (worker/server) and
 * aggregate-safe `runtime-client.on("telemetry")` markers (browser host).
 */
export function createRuntimeTelemetryOtelBridge(
  options: OtelBridgeOptions,
): RuntimeTelemetryOtelBridge {
  const { tracer, meter } = options;
  const actionRunSpanThresholdMs = options.actionRunSpanThresholdMs ?? 10;
  const base = options.attributes ?? {};
  const spanBase = options.spanAttributes
    ? { ...base, ...options.spanAttributes }
    : base;
  const attrs = (extra?: Attributes): Attributes =>
    extra ? { ...spanBase, ...extra } : spanBase;
  // Metric datapoints get metric-only labels; spans keep span-only labels.
  const mbase = options.metricAttributes
    ? { ...base, ...options.metricAttributes }
    : base;
  const mattrs = (extra?: Attributes): Attributes =>
    extra ? { ...mbase, ...extra } : mbase;

  // --- Instruments (created once; no-ops when no MeterProvider is set) --------
  const runs = meter.createCounter("ct.scheduler.runs", {
    description: "Scheduler action runs",
  });
  const invocations = meter.createCounter("ct.scheduler.invocations", {
    description: "Scheduler handler invocations",
  });
  const cellUpdates = meter.createCounter("ct.cell.updates", {
    description: "Cell/document updates observed by the runtime",
  });
  const commits = meter.createCounter("ct.scheduler.commits", {
    description: "Scheduler event commits",
  });
  const commitRetries = meter.createCounter("ct.scheduler.commit.retries", {
    description: "Commit retries due to transient write conflicts",
  });
  const commitChangedWrites = meter.createHistogram(
    "ct.scheduler.commit.changed_writes",
    { description: "Changed writes per commit" },
  );
  const commitWrites = meter.createHistogram("ct.scheduler.commit.writes", {
    description: "Changed writes plus classified no-op candidates per commit",
  });
  const commitNoopCandidates = meter.createHistogram(
    "ct.scheduler.commit.noop_candidate_writes",
    { description: "Deduplicated non-overlapping no-op candidates per commit" },
  );
  const commitReads = meter.createHistogram("ct.scheduler.commit.reads", {
    description: "Scheduler dependency reads per commit",
  });
  // Per-phase preflight timings — the scheduler's own breakdown of where an
  // event's cost goes. These are the multi-user hot-path signals.
  const preflightPhase = {
    populate: meter.createHistogram("ct.scheduler.preflight.populate_ms", {
      unit: "ms",
    }),
    txToLog: meter.createHistogram("ct.scheduler.preflight.tx_to_log_ms", {
      unit: "ms",
    }),
    depCommit: meter.createHistogram("ct.scheduler.preflight.dep_commit_ms", {
      unit: "ms",
    }),
    collect: meter.createHistogram("ct.scheduler.preflight.collect_ms", {
      unit: "ms",
    }),
    schedule: meter.createHistogram("ct.scheduler.preflight.schedule_ms", {
      unit: "ms",
    }),
    total: meter.createHistogram("ct.scheduler.preflight.total_ms", {
      unit: "ms",
    }),
  };
  const preflightDirtyDeps = meter.createHistogram(
    "ct.scheduler.preflight.dirty_dependency_count",
    { description: "Dirty dependencies collected per event" },
  );
  // Per-run action duration — the signal that names a hot derive directly
  // (group by ct.module). Same measurement ActionStats records.
  const actionDuration = meter.createHistogram(
    "ct.scheduler.action.duration_ms",
    { unit: "ms", description: "Scheduler action run duration" },
  );
  // Settle pass duration/iterations — the user-facing "event → stable graph"
  // numbers, emitted unconditionally per settle pass.
  const settleDuration = meter.createHistogram(
    "ct.scheduler.settle.duration_ms",
    { unit: "ms", description: "Settle loop wall-clock per pass" },
  );
  const settleIterations = meter.createHistogram(
    "ct.scheduler.settle.iterations",
    { description: "Settle iterations that ran work, per pass" },
  );
  // busyRatio is the runner-thrash smoking gun: fraction of a window spent busy.
  const busyRatio = meter.createHistogram("ct.scheduler.busy_ratio", {
    description: "Non-settling window busy ratio (0..1)",
  });
  const nonSettling = meter.createCounter("ct.scheduler.non_settling.events", {
    description: "Non-settling windows detected",
  });
  const storageOps = meter.createCounter("ct.storage.ops", {
    description: "Storage push/pull operations",
  });
  const storageDuration = meter.createHistogram("ct.storage.op.duration_ms", {
    unit: "ms",
    description: "Storage push/pull duration",
  });
  const storageConnection = meter.createCounter(
    "ct.storage.connection.updates",
    {
      description: "Storage connection status transitions",
    },
  );
  const subscriptions = meter.createUpDownCounter("ct.storage.subscriptions", {
    description: "Active storage subscriptions",
  });

  // --- In-flight storage spans, keyed by the marker `id` ---------------------
  type OpenOp = { span: Span; startMs: number };
  const openOps = new Map<string, OpenOp>();

  const patternAttrs = (
    info?: { patternName?: string; moduleName?: string },
  ): Attributes => {
    if (!info) return {};
    const out: Attributes = {};
    if (info.patternName) out["ct.pattern"] = info.patternName;
    if (info.moduleName) out["ct.module"] = info.moduleName;
    return out;
  };

  const startStorageOp = (
    id: string,
    kind: "push" | "pull",
    operation: string,
    extra?: Attributes,
  ) => {
    const span = tracer.startSpan(`storage.${kind}`, {
      attributes: attrs({
        "ct.storage.kind": kind,
        "ct.storage.operation": operation,
        ...extra,
      }),
    });
    openOps.set(id, { span, startMs: nowMs() });
  };

  const endStorageOp = (
    id: string,
    kind: "push" | "pull",
    error?: string,
    sessionId?: string,
  ) => {
    const open = openOps.get(id);
    const durationMs = open ? nowMs() - open.startMs : undefined;
    if (open) {
      if (sessionId) open.span.setAttribute("session.id", sessionId);
      if (error) {
        open.span.setStatus({ code: SpanStatusCode.ERROR, message: error });
        open.span.setAttribute("error", true);
      }
      open.span.end();
      openOps.delete(id);
    }
    storageOps.add(
      1,
      mattrs({ "ct.storage.kind": kind, "ct.storage.error": !!error }),
    );
    if (durationMs !== undefined) {
      storageDuration.record(durationMs, mattrs({ "ct.storage.kind": kind }));
    }
  };

  const handleRuntimeMarker = (marker: RuntimeTelemetryMarkerResult): void => {
    switch (marker.type) {
      case "scheduler.run":
        runs.add(
          1,
          mattrs({
            ...patternAttrs(marker.actionInfo),
            "ct.error": !!marker.error,
          }),
        );
        break;
      case "scheduler.run.complete": {
        actionDuration.record(
          marker.durationMs,
          mattrs({
            ...patternAttrs(marker.actionInfo),
            "ct.error": !!marker.error,
          }),
        );
        if (marker.durationMs >= actionRunSpanThresholdMs) {
          // Retroactive span, same technique as scheduler.preflight: the run
          // already happened; reconstruct its window from the duration.
          const end = Date.now();
          const span = tracer.startSpan("scheduler.action.run", {
            startTime: end - Math.round(marker.durationMs),
            attributes: attrs({
              ...patternAttrs(marker.actionInfo),
              "ct.action_id": marker.actionId,
              "ct.duration_ms": marker.durationMs,
            }),
          });
          if (marker.error) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: marker.error,
            });
          }
          span.end(end);
        }
        break;
      }
      case "scheduler.settle":
        settleDuration.record(marker.durationMs, mattrs());
        settleIterations.record(marker.iterations, mattrs());
        break;
      case "scheduler.invocation":
        // eventId is intentionally internal correlation state. Do not attach it
        // to OTel attributes or spans.
        invocations.add(1, mattrs(patternAttrs(marker.handlerInfo)));
        break;
      case "cell.update":
        cellUpdates.add(1, mattrs());
        break;
      case "scheduler.event.commit": {
        // eventId is intentionally internal correlation state. Do not attach it
        // to OTel attributes or spans.
        const commitAttributes = {
          ...patternAttrs(marker.handlerInfo),
          "ct.commit.terminal": marker.terminal ?? "none",
          "ct.error": !!marker.error,
        };
        const metricAttributes = mattrs(commitAttributes);
        commits.add(1, metricAttributes);
        commitWrites.record(marker.writeCount, metricAttributes);
        commitChangedWrites.record(marker.changedWriteCount, metricAttributes);
        commitNoopCandidates.record(
          Math.max(0, marker.writeCount - marker.changedWriteCount),
          metricAttributes,
        );
        commitReads.record(marker.readCount, metricAttributes);
        if (marker.backoffMs !== undefined) {
          commitRetries.add(1, metricAttributes);
        }
        break;
      }
      case "scheduler.event.drop":
        // Local diagnostics correlate these internally; OTel deliberately gets
        // neither event IDs nor a new event-level cardinality dimension.
        break;
      case "scheduler.event.preflight": {
        const total = marker.populateMs + marker.txToLogMs +
          marker.depCommitMs +
          marker.collectMs + marker.scheduleMs;
        const a = mattrs(patternAttrs(marker.handlerInfo));
        preflightPhase.populate.record(marker.populateMs, a);
        preflightPhase.txToLog.record(marker.txToLogMs, a);
        preflightPhase.depCommit.record(marker.depCommitMs, a);
        preflightPhase.collect.record(marker.collectMs, a);
        preflightPhase.schedule.record(marker.scheduleMs, a);
        preflightPhase.total.record(total, a);
        preflightDirtyDeps.record(marker.dirtyDependencyCount, a);
        // Retroactive span: the work already happened, so reconstruct its
        // window from the marker's total so it shows on a trace timeline.
        const end = Date.now();
        const span = tracer.startSpan("scheduler.preflight", {
          startTime: end - Math.round(total),
          attributes: attrs({
            ...patternAttrs(marker.handlerInfo),
            "ct.handler_id": marker.handlerId,
            "ct.read_count": marker.readCount,
            "ct.shallow_read_count": marker.shallowReadCount,
            "ct.dirty_dependency_count": marker.dirtyDependencyCount,
            // v2 preflight has no depth-tracked upstream walk (decision 15
            // inverted it); the walk's cost signal is its visit count.
            "ct.preflight.visit_count": marker.stats.visitCount,
            "ct.preflight.work_set_add_count": marker.stats.workSetAddCount,
            "ct.preflight.reverse_dependency_edge_count":
              marker.stats.reverseDependencyEdgeCount,
          }),
        });
        if (marker.error) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: marker.error });
        }
        span.end(end);
        break;
      }
      case "scheduler.non-settling":
        busyRatio.record(marker.busyRatio, mattrs());
        nonSettling.add(1, mattrs());
        break;
      case "storage.push.start":
        // localSeq/space join to the server's memory.transact span, which
        // stamps the same pair as commit.local_seq / space.did.
        startStorageOp(marker.id, "push", marker.operation, {
          ...(marker.localSeq !== undefined
            ? { "commit.local_seq": marker.localSeq }
            : {}),
          ...(marker.spaceDid ? { "space.did": marker.spaceDid } : {}),
        });
        break;
      case "storage.push.complete":
        endStorageOp(marker.id, "push", undefined, marker.sessionId);
        break;
      case "storage.push.error":
        endStorageOp(marker.id, "push", marker.error, marker.sessionId);
        break;
      case "storage.pull.start":
        startStorageOp(marker.id, "pull", marker.operation);
        break;
      case "storage.pull.complete":
        endStorageOp(marker.id, "pull");
        break;
      case "storage.pull.error":
        endStorageOp(marker.id, "pull", marker.error);
        break;
      case "storage.connection.update":
        storageConnection.add(
          1,
          mattrs({
            "ct.connection.status": marker.status,
            "ct.connection.attempt": marker.attempt,
          }),
        );
        break;
      case "storage.subscription.add":
        subscriptions.add(1, mattrs());
        break;
      case "storage.subscription.remove":
        subscriptions.add(-1, mattrs());
        break;
      case "scheduler.dependencies.update":
        // Dependency-graph churn is high-volume and mainly of interest to the
        // debug graph view; skip from OTel to keep cardinality/volume sane.
        break;
      case "scheduler.graph.snapshot":
      case "scheduler.subscribe":
        // Debug-view only; not exported.
        break;
    }
  };

  const handleHostMarker = (marker: HostRuntimeTelemetryMarker): void => {
    switch (marker.type) {
      case "scheduler.run":
        runs.add(1, mattrs({ "ct.error": !marker.ok }));
        break;
      case "scheduler.run.complete":
        actionDuration.record(
          marker.durationMs,
          mattrs({ "ct.error": !marker.ok }),
        );
        break;
      case "scheduler.settle":
        settleDuration.record(marker.durationMs, mattrs());
        settleIterations.record(marker.iterations, mattrs());
        break;
      case "scheduler.invocation":
        invocations.add(1, mattrs());
        break;
      case "cell.update":
        cellUpdates.add(1, mattrs());
        break;
      case "scheduler.event.commit": {
        const attributes = mattrs({
          "ct.commit.terminal": marker.terminal ?? "none",
          "ct.error": !marker.ok,
        });
        commits.add(1, attributes);
        commitWrites.record(marker.writeCount, attributes);
        commitChangedWrites.record(marker.changedWriteCount, attributes);
        commitNoopCandidates.record(
          Math.max(0, marker.writeCount - marker.changedWriteCount),
          attributes,
        );
        commitReads.record(marker.readCount, attributes);
        if (marker.backoffMs !== undefined) commitRetries.add(1, attributes);
        break;
      }
      case "scheduler.event.preflight": {
        const total = marker.populateMs + marker.txToLogMs +
          marker.depCommitMs + marker.collectMs + marker.scheduleMs;
        const attributes = mattrs();
        preflightPhase.populate.record(marker.populateMs, attributes);
        preflightPhase.txToLog.record(marker.txToLogMs, attributes);
        preflightPhase.depCommit.record(marker.depCommitMs, attributes);
        preflightPhase.collect.record(marker.collectMs, attributes);
        preflightPhase.schedule.record(marker.scheduleMs, attributes);
        preflightPhase.total.record(total, attributes);
        preflightDirtyDeps.record(marker.dirtyDependencyCount, attributes);
        break;
      }
      case "scheduler.non-settling":
        busyRatio.record(marker.busyRatio, mattrs());
        nonSettling.add(1, mattrs());
        break;
      case "storage.connection.update":
        storageConnection.add(
          1,
          mattrs({
            "ct.connection.status": marker.status,
            "ct.connection.attempt": marker.attempt,
          }),
        );
        break;
      case "storage.subscription.add":
        subscriptions.add(1, mattrs());
        break;
      case "storage.subscription.remove":
        subscriptions.add(-1, mattrs());
        break;
      case "scheduler.event.drop":
      case "storage.push.start":
      case "storage.push.complete":
      case "storage.push.error":
      case "storage.pull.start":
      case "storage.pull.complete":
      case "storage.pull.error":
      case "scheduler.graph.snapshot":
      case "scheduler.subscribe":
      case "scheduler.dependencies.update":
        break;
    }
  };

  const handleMarker = (
    marker: HostRuntimeTelemetryMarker | RuntimeTelemetryMarkerResult,
  ): void => {
    if (isHostRuntimeTelemetryMarker(marker)) {
      handleHostMarker(marker);
      return;
    }
    handleRuntimeMarker(marker);
  };

  const shutdown = () => {
    for (const { span } of openOps.values()) span.end();
    openOps.clear();
  };

  return { handleMarker, shutdown };
}

function isHostRuntimeTelemetryMarker(
  marker: HostRuntimeTelemetryMarker | RuntimeTelemetryMarkerResult,
): marker is HostRuntimeTelemetryMarker {
  switch (marker.type) {
    case "scheduler.run":
    case "scheduler.run.complete":
    case "scheduler.invocation":
    case "scheduler.event.commit":
    case "scheduler.event.preflight":
    case "storage.push.start":
    case "storage.push.complete":
    case "storage.push.error":
    case "storage.pull.start":
    case "storage.pull.complete":
    case "storage.pull.error":
    case "storage.connection.update":
    case "storage.subscription.add":
    case "storage.subscription.remove":
      return "ok" in marker;
    case "scheduler.graph.snapshot":
      return "nodeCount" in marker;
    case "scheduler.dependencies.update":
      return "readCount" in marker;
    case "cell.update":
      return !("change" in marker);
    case "scheduler.event.drop":
      return !("eventId" in marker);
    case "scheduler.subscribe":
      return !("actionId" in marker);
    case "scheduler.settle":
    case "scheduler.non-settling":
      return true;
  }
}

function nowMs(): number {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}
