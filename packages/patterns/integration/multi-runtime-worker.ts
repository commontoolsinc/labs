/**
 * Worker-side runtime host for the multi-runtime harness.
 *
 * Each worker owns ONE full client stack — Identity, StorageManager, Runtime,
 * PiecesController — in its own JS realm, exactly like one browser tab. The
 * main thread orchestrates via a tiny request/response protocol.
 */

import type {
  Cell,
  RuntimeTelemetryMarker,
  SchedulerGraphSnapshot,
} from "@commonfabric/runner";
import {
  classifyTelemetryWriteCounts,
  markRendererInputTx,
  markUiInputBlindWriteTx,
  setBlindStructuralTarget,
  unmarkUiInputBlindWriteTx,
} from "@commonfabric/runner";
import { markRendererTrustedEvent } from "@commonfabric/runner/cfc";
import { Identity, type KeyPairRaw } from "@commonfabric/identity";
import {
  initializePiecesController,
  type PieceController,
  PiecesController,
} from "./pieces-controller.ts";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import { writePathShape } from "./telemetry-path-shape.ts";
import { hashStringOf } from "@commonfabric/data-model/value-hash";

export interface WorkerRequest {
  id: number;
  cmd: string;
  args: Record<string, unknown>;
}

export type WorkerResponse =
  | { id: number; ok: unknown }
  | { id: number; error: string };

export interface TrustedUiDescriptor {
  /** `data-ui-pattern` / `data-ui-event-integrity` of the trusted surface. */
  surface: string;
  /** `data-ui-action` of the control inside the surface. */
  action: string;
}

export interface RuntimeDiagnosticsSnapshot {
  graph: SchedulerGraphSnapshot;
  settleStatsHistory: unknown[];
  actionRunTrace: unknown[];
}

/** Content-free scheduler aggregates suitable for cross-worker diagnostics. */
export interface RuntimeDiagnosticsSummary {
  nodeCount: number;
  edgeCount: number;
  dirtyNodeCount: number;
  pendingNodeCount: number;
  settleHistoryEntryCount: number;
  maxTrailingSettleDurationMs: number;
}

/** Counter-only local scheduler telemetry; no pattern values are retained. */
export interface RuntimeTelemetrySnapshot {
  invocationCount: number;
  /** Distinct event IDs observed only inside the worker, never returned. */
  distinctInvokedEventCount: number;
  distinctSuccessfulEventCount: number;
  distinctDroppedEventCount: number;
  droppedEventsByReason: Record<
    "piece-load" | "lineage" | "preflight" | "load-gate",
    number
  >;
  permanentRejectionsByReason: Record<
    "origin-committed" | "receipt-exists",
    number
  >;
  /** Scheduler event commit markers observed. */
  commitMarkerCount: number;
  /** Direct UI-style set/push commits recorded by this harness worker. */
  directCommitCount: number;
  successfulCommitCount: number;
  failedAttemptCount: number;
  terminalFailureCount: number;
  retryMarkerCount: number;
  maxRetryAttempt: number;
  readCount: number;
  writeCount: number;
  changedWriteCount: number;
  writesTruncatedCount: number;
  writesByPathShape: Record<string, number>;
}

/** Aggregate-only Topics state used for private cross-worker convergence checks. */
export type TopicsDiagnosticsSummary =
  | {
    ok: true;
    topics: number;
    comments: number;
    links: number;
  }
  | { ok: false; error: "operation-failed" };

/** Fixed outcome returned by Topics-only mutation commands. */
export interface TopicsDiagnosticsOperationOutcome {
  ok: boolean;
  error?: "operation-failed";
}

export interface TopicsDiagnosticsNoopOutcome
  extends TopicsDiagnosticsOperationOutcome {
  submitted: number;
  directAccepted: number;
  directRejected: number;
}

export interface TopicsDiagnosticsCrossrefValidation {
  ok: boolean;
  validatedSources: number;
}

/** Fixed storage-churn counters used by aggregate-only Topics diagnostics. */
export interface TopicsDiagnosticsChurnTotals {
  commitConflicts: number;
  commitPreempted: number;
  commitHeldRevert: number;
  commitHeldSent: number;
  commitReverts: number;
  commitRejected: number;
}

class LocalRuntimeTelemetry {
  #snapshot: RuntimeTelemetrySnapshot = LocalRuntimeTelemetry.empty();
  #invokedEventIds = new Set<string>();
  #successfulEventIds = new Set<string>();
  #droppedEventIds = new Set<string>();

  static empty(): RuntimeTelemetrySnapshot {
    return {
      invocationCount: 0,
      distinctInvokedEventCount: 0,
      distinctSuccessfulEventCount: 0,
      distinctDroppedEventCount: 0,
      droppedEventsByReason: {
        "piece-load": 0,
        lineage: 0,
        preflight: 0,
        "load-gate": 0,
      },
      permanentRejectionsByReason: {
        "origin-committed": 0,
        "receipt-exists": 0,
      },
      commitMarkerCount: 0,
      directCommitCount: 0,
      successfulCommitCount: 0,
      failedAttemptCount: 0,
      terminalFailureCount: 0,
      retryMarkerCount: 0,
      maxRetryAttempt: 0,
      readCount: 0,
      writeCount: 0,
      changedWriteCount: 0,
      writesTruncatedCount: 0,
      writesByPathShape: {},
    };
  }

  record(marker: RuntimeTelemetryMarker): void {
    if (marker.type === "scheduler.invocation") {
      this.#snapshot.invocationCount++;
      this.#invokedEventIds.add(marker.eventId);
      this.#snapshot.distinctInvokedEventCount = this.#invokedEventIds.size;
      return;
    }
    if (marker.type === "scheduler.event.drop") {
      this.#droppedEventIds.add(marker.eventId);
      this.#snapshot.distinctDroppedEventCount = this.#droppedEventIds.size;
      this.#snapshot.droppedEventsByReason[marker.reason]++;
      return;
    }
    if (marker.type !== "scheduler.event.commit") return;

    this.#snapshot.commitMarkerCount++;
    this.#recordCommit({
      readCount: marker.readCount,
      writeCount: marker.writeCount,
      changedWriteCount: marker.changedWriteCount,
      writes: marker.writes.map(markerPath),
      failed: marker.error !== undefined,
    });
    if (marker.writesTruncated) this.#snapshot.writesTruncatedCount++;
    if (marker.error === undefined) {
      this.#successfulEventIds.add(marker.eventId);
      this.#snapshot.distinctSuccessfulEventCount =
        this.#successfulEventIds.size;
    }
    if (marker.permanentRejection !== undefined) {
      this.#snapshot.permanentRejectionsByReason[marker.permanentRejection]++;
    }
    if (marker.terminal) this.#snapshot.terminalFailureCount++;
    if (marker.backoffMs !== undefined && marker.retryAttempt !== undefined) {
      this.#snapshot.retryMarkerCount++;
      this.#snapshot.maxRetryAttempt = Math.max(
        this.#snapshot.maxRetryAttempt,
        marker.retryAttempt,
      );
    }
  }

  recordDirectCommit(
    summary: {
      readCount: number;
      writeCount: number;
      changedWriteCount: number;
      writes: readonly string[];
      failed: boolean;
    },
  ): void {
    this.#snapshot.directCommitCount++;
    this.#recordCommit(summary);
  }

  #recordCommit(summary: {
    readCount: number;
    writeCount: number;
    changedWriteCount: number;
    writes: readonly string[];
    failed: boolean;
  }): void {
    this.#snapshot.readCount += summary.readCount;
    this.#snapshot.writeCount += summary.writeCount;
    this.#snapshot.changedWriteCount += summary.changedWriteCount;
    if (summary.failed) this.#snapshot.failedAttemptCount++;
    else this.#snapshot.successfulCommitCount++;
    for (const path of summary.writes) {
      const shape = writePathShape(path);
      this.#snapshot.writesByPathShape[shape] =
        (this.#snapshot.writesByPathShape[shape] ?? 0) + 1;
    }
  }

  snapshotAndReset(): RuntimeTelemetrySnapshot {
    const snapshot = {
      ...this.#snapshot,
      writesByPathShape: { ...this.#snapshot.writesByPathShape },
      droppedEventsByReason: { ...this.#snapshot.droppedEventsByReason },
      permanentRejectionsByReason: {
        ...this.#snapshot.permanentRejectionsByReason,
      },
    };
    this.#snapshot = LocalRuntimeTelemetry.empty();
    this.#invokedEventIds.clear();
    this.#successfulEventIds.clear();
    this.#droppedEventIds.clear();
    return snapshot;
  }
}

let cc: PiecesController | undefined;
let piece: PieceController | undefined;
let resultSchema: unknown;
let resultSinkCancel: (() => void) | undefined;
let telemetry: LocalRuntimeTelemetry | undefined;
let telemetryListener: ((event: Event) => void) | undefined;
let releaseDetailedEventCommitTelemetry: (() => void) | undefined;
let diagnosticsEnabled = false;
let aggregateOnlyDiagnostics = false;
let aggregateBootstrapCreator = false;
let aggregateBootstrapChannel: string | undefined;
let aggregateBootstrapParticipants = 0;
let diagnosticMutationsEnabled = false;
let diagnosticsActivityGeneration = 0;
let pendingContainingDocumentRootCommit: (() => Promise<unknown>) | undefined;
let delayedFrameCount = 0;
let delayedFrameDrainers: (() => void)[] = [];
let bootstrapChannel: BroadcastChannel | undefined;
let bootstrapPieceId: string | undefined;
let bootstrapReady: (() => void) | undefined;
let convergenceChannel: BroadcastChannel | undefined;
let convergenceExpected = 0;
let convergenceEntries: {
  token: string;
  topics: number;
  comments: number;
  links: number;
}[] = [];
let convergenceReady: (() => void) | undefined;
let convergencePublishChannels: BroadcastChannel[] = [];
let privateTopicsEqualityToken: string | undefined;
let restoreAggregateConsole: (() => void) | undefined;

async function seedDeterministicProfile(): Promise<void> {
  const runtime = controller().manager().runtime;
  const userDid = runtime.userIdentityDID;
  const profileDid = (await Identity.fromPassphrase(
    `topics-diagnostics-profile:${userDid}`,
    { implementation: "noble" },
  )).did();
  const profileDefaultId = "topics-diagnostics-profile-default";

  const profileTx = runtime.edit();
  const profileDefault = runtime.getCell<unknown>(
    profileDid,
    profileDefaultId,
    undefined,
    profileTx,
  );
  profileDefault.set({
    name: "Topics Diagnostics",
    initialNameApplied: "Topics Diagnostics",
    avatar: "",
    bio: "",
    elements: [],
  });
  runtime.getSpaceCell(profileDid, undefined, profileTx).key("defaultPattern")
    .set(profileDefault);
  await profileTx.commit();
  await runtime.idle();

  const homeTx = runtime.edit();
  const homeDefault = runtime.getCell<unknown>(
    userDid,
    "topics-diagnostics-home-default",
    undefined,
    homeTx,
  );
  const profileLink = runtime.getCell<unknown>(
    profileDid,
    profileDefaultId,
    undefined,
    homeTx,
  );
  homeDefault.key("profiles").set([profileLink]);
  runtime.getHomeSpaceCell(homeTx).key("defaultPattern").set(homeDefault);
  await homeTx.commit();
  await runtime.idle();
}

function suppressAggregateConsole(): void {
  if (restoreAggregateConsole) return;
  const debug = console.debug;
  const error = console.error;
  const info = console.info;
  const log = console.log;
  const warn = console.warn;
  console.debug = () => {};
  console.error = () => {};
  console.info = () => {};
  console.log = () => {};
  console.warn = () => {};
  restoreAggregateConsole = () => {
    console.debug = debug;
    console.error = error;
    console.info = info;
    console.log = log;
    console.warn = warn;
    restoreAggregateConsole = undefined;
  };
}

const fixedSuccess = () => ({ ok: true } as const);
const fixedFailure = () => ({ ok: false, error: "operation-failed" } as const);

function closeTopicsChannels(): void {
  bootstrapChannel?.close();
  bootstrapChannel = undefined;
  bootstrapPieceId = undefined;
  bootstrapReady?.();
  bootstrapReady = undefined;
  convergenceChannel?.close();
  convergenceChannel = undefined;
  convergenceExpected = 0;
  convergenceEntries = [];
  for (const channel of convergencePublishChannels) channel.close();
  convergencePublishChannels = [];
  convergenceReady?.();
  convergenceReady = undefined;
}

function beginDelayedFrame(): () => void {
  delayedFrameCount++;
  return () => {
    delayedFrameCount--;
    if (delayedFrameCount === 0) {
      for (const resolve of delayedFrameDrainers) resolve();
      delayedFrameDrainers = [];
    }
  };
}

async function awaitDelayedFramesDrained(): Promise<void> {
  if (delayedFrameCount === 0) return;
  await new Promise<void>((resolve) => delayedFrameDrainers.push(resolve));
}

function trailingSettleDuration(history: unknown): number {
  if (!Array.isArray(history)) return 0;
  return history.slice(-5).reduce((maximum, entry) => {
    const stats = isRecord(entry) && isRecord(entry.stats) ? entry.stats : {};
    const duration = stats.totalDurationMs;
    return typeof duration === "number" && Number.isFinite(duration)
      ? Math.max(maximum, duration)
      : maximum;
  }, 0);
}

function controller(): PiecesController {
  if (!cc) throw new Error("worker not initialized");
  return cc;
}

function currentPiece(): PieceController {
  if (!piece) throw new Error("no piece attached");
  return piece;
}

function normalizePath(
  value: unknown,
  description: string,
  allowEmpty = false,
): (string | number)[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(
      `${description} must be ${allowEmpty ? "a" : "a non-empty"} ` +
        "(string | number)[] path",
    );
  }
  const path: (string | number)[] = [];
  for (const segment of value) {
    if (typeof segment === "string" && segment.length > 0) {
      path.push(segment);
      continue;
    }
    if (
      typeof segment === "number" && Number.isInteger(segment) && segment >= 0
    ) {
      path.push(segment);
      continue;
    }
    throw new Error(
      `${description} contains an invalid path segment: ${
        JSON.stringify(segment)
      }`,
    );
  }
  return path;
}

function normalizeSendTarget(value: unknown): (string | number)[] {
  if (typeof value === "string" && value.length > 0) return [value];
  return normalizePath(value, "send target");
}

function normalizeOmitKeys(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((key) => typeof key !== "string" || key.length === 0)
  ) {
    throw new Error("read omitKeys must be a string[] of non-empty keys");
  }
  return [...new Set(value)];
}

function displayPath(path: readonly (string | number)[]): string {
  return path.map((segment) => JSON.stringify(segment)).join(".");
}

function markerPath(address: string): string {
  // Commit markers identify addresses as space/entity/path. Keep only the
  // structural path for workload attribution; diagnostics must not retain IDs.
  const segments = address.split("/");
  return segments.slice(2).join("/") || "$root";
}

// Read through the pattern's declared result schema, like the UI does —
// schema defaults and scope annotations only apply on schema-aware reads.
function result(): Cell<any> {
  const raw = controller().manager().getResult(currentPiece().getCell());
  return resultSchema !== undefined ? raw.asSchema(resultSchema as never) : raw;
}

async function idle(): Promise<void> {
  await controller().manager().runtime.idle();
  await controller().manager().synced();
}

async function settled(): Promise<void> {
  await controller().manager().runtime.settled();
}

async function attachPiece(next: PieceController): Promise<void> {
  piece = next;
  resultSchema = (await next.getPattern() as { resultSchema?: unknown })
    .resultSchema;
  resultSinkCancel?.();
  // Keep the result graph subscribed so server pushes reach this runtime.
  resultSinkCancel = result().sink(() => {});
}

/**
 * Make `value` postMessage-safe: keep JSON data, drop functions/cells,
 * stringify bigints (JSON.stringify throws on them).
 */
function sanitizeForTransfer(
  value: unknown,
  omitKeys: readonly string[] = [],
): unknown {
  if (value === undefined) return undefined;
  const omitted = new Set(omitKeys);
  return JSON.parse(JSON.stringify(value, (_key, entry) => {
    if (omitted.has(_key)) return undefined;
    if (typeof entry === "function") return undefined;
    if (typeof entry === "bigint") return entry.toString();
    return entry;
  }));
}

// Test-only network shaping: wrap this realm's WebSocket so every frame (both
// directions) is delayed by a fixed amount. Installed BEFORE the runtime opens
// its storage session, so the whole client stack sees the added latency —
// the in-process equivalent of the browser-harness WS shim used to reproduce
// multiplayer contention (starvation / wedge) without a network.
function installWsDelay(delayMs: number): void {
  if (delayMs <= 0) return;
  const Native = globalThis.WebSocket;
  const Delayed = function (
    this: WebSocket,
    url: string | URL,
    protocols?: string | string[],
  ): WebSocket {
    const ws = protocols !== undefined
      ? new Native(url, protocols)
      : new Native(url);
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const nativeAdd = ws.addEventListener.bind(ws);
    const nativeRemove = ws.removeEventListener.bind(ws);
    ws.addEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === "message" && listener) listeners.add(listener);
      else if (listener) nativeAdd(type, listener, options);
    };
    // Mirror removal for the diverted message listeners, preserving
    // WebSocket semantics for callers that unsubscribe/re-subscribe.
    ws.removeEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) => {
      if (type === "message" && listener) listeners.delete(listener);
      else if (listener) nativeRemove(type, listener, options);
    };
    let onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null =
      null;
    Object.defineProperty(ws, "onmessage", {
      configurable: true,
      get: () => onmessage,
      set: (fn) => {
        onmessage = fn;
      },
    });
    nativeAdd("message", (ev: Event) => {
      const deliver = () => {
        onmessage?.call(ws, ev as MessageEvent);
        for (const listener of listeners) {
          const fn = typeof listener === "function"
            ? listener
            : listener.handleEvent.bind(listener);
          fn.call(ws, ev);
        }
      };
      const done = beginDelayedFrame();
      setTimeout(() => {
        try {
          deliver();
        } finally {
          done();
        }
      }, delayMs);
    });
    const nativeSend = ws.send.bind(ws);
    ws.send = (data: Parameters<WebSocket["send"]>[0]) => {
      const done = beginDelayedFrame();
      setTimeout(() => {
        try {
          nativeSend(data);
        } catch {
          // Socket closed while the frame was in flight; same as a network drop.
        } finally {
          done();
        }
      }, delayMs);
    };
    return ws;
  } as unknown as typeof WebSocket;
  Delayed.prototype = Native.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) {
    (Delayed as unknown as Record<string, unknown>)[k] = Native[k];
  }
  globalThis.WebSocket = Delayed;
}

// When the harness process runs under Deno's native OpenTelemetry
// (`OTEL_DENO=true deno run --unstable-otel …` — the harness has no SDK setup
// of its own), `@opentelemetry/api`'s globals resolve to Deno's providers, so
// bridging the runtime's existing telemetry bus exports scheduler spans and
// ct.* metrics with zero configuration. Inert otherwise: without a registered
// provider the API hands the bridge no-op instruments. Also flips the
// preflight-telemetry gate, which is what runtime-client's
// setTelemetryEnabled(true) does for browser sessions — without it the
// scheduler.event.preflight markers never fire.
async function maybeAttachOtelBridge(identity: Identity): Promise<void> {
  const env = (name: string): string | undefined =>
    typeof Deno !== "undefined" ? Deno.env.get(name) : undefined;
  const otelActive = env("OTEL_DENO") === "true" || env("OTEL_DENO") === "1" ||
    env("OTEL_ENABLED") === "true";
  if (!otelActive) return;
  const [{ attachRuntimeTelemetryOtelBridge }, { metrics, trace }] =
    await Promise.all([
      import("@commonfabric/runner/telemetry-otel-bridge"),
      import("@opentelemetry/api"),
    ]);
  const manager = controller().manager();
  const runtime = manager.runtime;
  attachRuntimeTelemetryOtelBridge(runtime.telemetry, {
    tracer: trace.getTracer("ct-runner-bridge"),
    meter: metrics.getMeter("ct-runner-bridge"),
    attributes: {
      "ct.runtime": "harness",
    },
    spanAttributes: {
      "space.did": manager.getSpace(),
      "user.did": identity.did(),
    },
  });
  runtime.scheduler.setEventPreflightTelemetryEnabled(true);
}

function topicsCell(path: readonly (string | number)[] = []): Cell<any> {
  let cell = result();
  for (const segment of path) cell = cell.key(segment as never) as Cell<any>;
  return cell;
}

async function syncResultTopology(
  path: readonly (string | number)[] = [],
): Promise<Cell<any>> {
  let cell = result();
  await cell.sync();
  await cell.pull();
  for (const segment of path) {
    cell = cell.key(segment as never).resolveAsCell();
    await cell.sync();
    await cell.pull();
  }
  return cell;
}

const asTopicsRecordArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const asTopicsNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

interface TopicsContentProjection {
  title: string;
  body: string;
  createdAt: number;
  createdBy?: TopicsAuthorProjection;
  createdByName: string;
  bodyUpdatedBy?: TopicsAuthorProjection;
  bodyUpdatedAt: number;
  comments: {
    author?: TopicsAuthorProjection;
    authorName: string;
    body: string;
    sentAt: number;
  }[];
  links: {
    kind: string;
    url: string;
    label: string;
    addedBy?: TopicsAuthorProjection;
    addedAt: number;
  }[];
}

interface TopicsAuthorProjection {
  kind: string;
  name: string;
  avatar: string;
}

function topicsAuthorProjection(
  value: unknown,
): TopicsAuthorProjection | undefined {
  if (!isRecord(value)) return undefined;
  return {
    kind: typeof value.kind === "string" ? value.kind : "",
    name: typeof value.name === "string" ? value.name : "",
    avatar: typeof value.avatar === "string" ? value.avatar : "",
  };
}

function topicsContentProjection(
  values: Record<string, unknown>,
): TopicsContentProjection {
  return {
    title: typeof values.title === "string" ? values.title : "",
    body: typeof values.body === "string" ? values.body : "",
    createdAt: asTopicsNumber(values.createdAt),
    createdBy: topicsAuthorProjection(values.createdBy),
    createdByName: typeof values.createdByName === "string"
      ? values.createdByName
      : "",
    bodyUpdatedBy: topicsAuthorProjection(values.bodyUpdatedBy),
    bodyUpdatedAt: asTopicsNumber(values.bodyUpdatedAt),
    comments: asTopicsRecordArray(values.comments).map((comment) => ({
      author: topicsAuthorProjection(comment.author),
      authorName: typeof comment.authorName === "string"
        ? comment.authorName
        : "",
      body: typeof comment.body === "string" ? comment.body : "",
      sentAt: asTopicsNumber(comment.sentAt),
    })),
    links: asTopicsRecordArray(values.links).map((link) => ({
      kind: typeof link.kind === "string" ? link.kind : "",
      url: typeof link.url === "string" ? link.url : "",
      label: typeof link.label === "string" ? link.label : "",
      addedBy: topicsAuthorProjection(link.addedBy),
      addedAt: asTopicsNumber(link.addedAt),
    })),
  };
}

async function topicsDiagnosticsSummary(): Promise<TopicsDiagnosticsSummary> {
  await syncResultTopology();
  const topics = topicsCell(["topics"]);
  await topics.sync();
  const pulledTopics = await topics.pull();
  const entries = Array.isArray(pulledTopics) ? pulledTopics : [];
  type SharedTopicsProjection = TopicsContentProjection & {
    link: { id: string; space: string; scope: string; path: string[] };
  };
  const projection: (SharedTopicsProjection | null)[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) {
      projection.push(null);
      continue;
    }
    const topic = topics.key(index) as Cell<any>;
    await topic.sync();
    await topic.pull();
    const link = topic.resolveAsCell().getAsNormalizedFullLink();
    projection.push({
      ...topicsContentProjection(entry),
      link: {
        id: link.id,
        space: link.space,
        scope: link.scope,
        path: [...link.path],
      },
    });
  }
  privateTopicsEqualityToken = hashStringOf(projection);
  const present = projection.filter((topic): topic is SharedTopicsProjection =>
    topic !== null
  );
  return {
    ok: true,
    topics: present.length,
    comments: present.reduce(
      (total, topic) => total + topic.comments.length,
      0,
    ),
    links: present.reduce((total, topic) => total + topic.links.length, 0),
  };
}

async function privateTopicsConvergence(): Promise<
  { token: string; topics: number; comments: number; links: number }
> {
  const summary = await topicsDiagnosticsSummary();
  if (!summary.ok) throw new Error("operation-failed");
  if (!privateTopicsEqualityToken) throw new Error("operation-failed");
  return {
    token: privateTopicsEqualityToken,
    topics: summary.topics,
    comments: summary.comments,
    links: summary.links,
  };
}

const topicsOperationFailure = (): TopicsDiagnosticsOperationOutcome => ({
  ok: false,
  error: "operation-failed",
});

function preparedAggregateBootstrap():
  | { channel: string; participants: number }
  | undefined {
  if (
    !aggregateBootstrapCreator || aggregateBootstrapChannel === undefined ||
    aggregateBootstrapParticipants < 1
  ) {
    return undefined;
  }
  return {
    channel: aggregateBootstrapChannel,
    participants: aggregateBootstrapParticipants,
  };
}

const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  async init({
    rawIdentity,
    spaceName,
    apiUrl,
    diagnostics,
    aggregateOnlyDiagnostics: aggregateOnly,
    aggregateBootstrapCreator: bootstrapCreator,
    aggregateBootstrapChannel: creatorChannel,
    aggregateBootstrapParticipants: creatorParticipants,
    diagnosticMutationsEnabled: enableDiagnosticMutations,
    bootstrapProfile,
    wsDelayMs,
  }) {
    if (cc) {
      if (aggregateOnlyDiagnostics || aggregateOnly === true) {
        return fixedFailure();
      }
      throw new Error("worker already initialized");
    }
    const aggregate = aggregateOnly === true;
    const creator = aggregate && bootstrapCreator === true;
    if (
      creator &&
      (typeof creatorChannel !== "string" || creatorChannel.length === 0 ||
        typeof creatorParticipants !== "number" ||
        !Number.isSafeInteger(creatorParticipants) ||
        creatorParticipants < 1)
    ) {
      return fixedFailure();
    }
    aggregateOnlyDiagnostics = aggregateOnly === true;
    aggregateBootstrapCreator = creator;
    aggregateBootstrapChannel = creator && typeof creatorChannel === "string"
      ? creatorChannel
      : undefined;
    aggregateBootstrapParticipants = creator &&
        typeof creatorParticipants === "number"
      ? creatorParticipants
      : 0;
    if (aggregateOnlyDiagnostics) suppressAggregateConsole();
    const identity = await Identity.deserialize(rawIdentity as KeyPairRaw);
    if (typeof wsDelayMs === "number") installWsDelay(wsDelayMs);
    cc = await initializePiecesController({
      apiUrl: new URL(apiUrl as string),
      identity,
      spaceName: spaceName as string,
    });
    diagnosticsEnabled = diagnostics === true;
    diagnosticMutationsEnabled = enableDiagnosticMutations === true;
    diagnosticsActivityGeneration = 0;
    if (bootstrapProfile === true) await seedDeterministicProfile();
    if (diagnosticsEnabled) {
      const runtime = controller().manager().runtime;
      const scheduler = runtime.scheduler;
      scheduler.enableSettleStats();
      scheduler.setActionRunTraceEnabled(true);
      releaseDetailedEventCommitTelemetry = runtime.telemetry
        .retainDetailedEventCommitTelemetry();
      telemetry = new LocalRuntimeTelemetry();
      telemetryListener = (event: Event) => {
        const marker =
          (event as CustomEvent<{ marker: RuntimeTelemetryMarker }>)
            .detail.marker;
        telemetry?.record(marker);
        diagnosticsActivityGeneration++;
      };
      runtime.telemetry.addEventListener("telemetry", telemetryListener);
    }
    if (!aggregateOnlyDiagnostics) await maybeAttachOtelBridge(identity);
    return {};
  },

  async createPiece({
    programPath,
    rootPath,
    input,
  }) {
    const aggregateBootstrap = aggregateOnlyDiagnostics
      ? preparedAggregateBootstrap()
      : undefined;
    if (aggregateOnlyDiagnostics && aggregateBootstrap === undefined) {
      return fixedFailure();
    }
    const program = await controller().manager().runtime.harness.resolve(
      new FileSystemProgramResolver(
        programPath as string,
        rootPath as string,
      ),
    );
    const created = await controller().create(program, {
      input: isRecord(input) ? input : undefined,
      start: true,
    });
    await attachPiece(created);
    await idle();
    if (aggregateBootstrap) {
      const broadcast = new BroadcastChannel(aggregateBootstrap.channel);
      let acknowledgements = 0;
      await new Promise<void>((resolve) => {
        broadcast.onmessage = (event: MessageEvent<unknown>) => {
          if (isRecord(event.data) && event.data.bootstrapAck === true) {
            acknowledgements++;
            if (acknowledgements === aggregateBootstrap.participants) resolve();
          }
        };
        broadcast.postMessage({ pieceId: created.id });
      });
      broadcast.close();
      return fixedSuccess();
    }
    return { pieceId: created.id };
  },

  async openPiece({ pieceId }) {
    await attachPiece(await controller().get(pieceId as string, true));
    await idle();
    return {};
  },

  async send({ target, event, trustedUi, idle: doIdle }) {
    const trusted = trustedUi as TrustedUiDescriptor | undefined;
    let eventValue: unknown = event ?? {};
    if (trusted) {
      // Equivalent of a genuine user interaction on a trusted surface: DOM
      // provenance plus the renderer-trusted mark the html worker reconciler
      // applies when delivering real DOM events.
      eventValue = {
        type: "click",
        ...(isRecord(event) ? event : {}),
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: trusted.surface,
            eventIntegrity: [trusted.surface],
            uiContractDataset: { uiAction: trusted.action },
          },
        },
      };
      markRendererTrustedEvent(eventValue);
    }
    const targetPath = normalizeSendTarget(target);
    let stream = result();
    for (const segment of targetPath) {
      stream = stream.key(segment as never);
    }
    const { error } = await controller().manager().runtime.editWithRetry(
      (tx) => {
        stream.withTx(tx).send(eventValue as never);
      },
    );
    if (error) {
      throw new Error(
        `send ${displayPath(targetPath)} failed: ${error.message}`,
      );
    }
    // `idle: false` returns as soon as the event is queued, leaving the action
    // run + commit in flight — lets a test stack several sends into a deep
    // optimistic pipeline (the multiplayer-contention shape) instead of
    // serializing one settled commit per event.
    if (doIdle !== false) await idle();
    return {};
  },

  async topicsDiagnosticsSummary() {
    try {
      return await topicsDiagnosticsSummary();
    } catch {
      return topicsOperationFailure();
    }
  },

  topicsDiagnosticsPrepareBootstrap({ channel }) {
    try {
      if (!aggregateOnlyDiagnostics || typeof channel !== "string") {
        return Promise.resolve(fixedFailure());
      }
      bootstrapChannel?.close();
      bootstrapPieceId = undefined;
      bootstrapChannel = new BroadcastChannel(channel);
      bootstrapChannel.onmessage = (event: MessageEvent<unknown>) => {
        if (isRecord(event.data) && typeof event.data.pieceId === "string") {
          bootstrapPieceId = event.data.pieceId;
          bootstrapChannel?.postMessage({ bootstrapAck: true });
          bootstrapReady?.();
          bootstrapReady = undefined;
        }
      };
      return Promise.resolve({ ok: true, ready: true });
    } catch {
      return Promise.resolve(fixedFailure());
    }
  },

  async topicsDiagnosticsFinishBootstrap() {
    try {
      if (!aggregateOnlyDiagnostics || !bootstrapChannel) return fixedFailure();
      if (!bootstrapPieceId) {
        await new Promise<void>((resolve) => bootstrapReady = resolve);
      }
      if (!bootstrapPieceId) return fixedFailure();
      await attachPiece(await controller().get(bootstrapPieceId, true));
      await idle();
      bootstrapChannel.close();
      bootstrapChannel = undefined;
      bootstrapPieceId = undefined;
      return fixedSuccess();
    } catch {
      return fixedFailure();
    }
  },

  topicsDiagnosticsConvergenceBegin({ channel, participants }) {
    try {
      if (
        !aggregateOnlyDiagnostics || typeof channel !== "string" ||
        typeof participants !== "number" ||
        !Number.isSafeInteger(participants) || participants < 1 ||
        convergenceChannel
      ) return Promise.resolve(fixedFailure());
      convergenceExpected = participants;
      convergenceEntries = [];
      convergenceChannel = new BroadcastChannel(channel);
      convergenceChannel.onmessage = (event: MessageEvent<unknown>) => {
        const value = event.data;
        if (
          !isRecord(value) || typeof value.token !== "string" ||
          typeof value.receipt !== "string" ||
          typeof value.topics !== "number" ||
          typeof value.comments !== "number" ||
          typeof value.links !== "number"
        ) return;
        convergenceEntries.push({
          token: value.token,
          topics: value.topics,
          comments: value.comments,
          links: value.links,
        });
        convergenceChannel?.postMessage({ ack: value.receipt });
        if (convergenceEntries.length === convergenceExpected) {
          convergenceReady?.();
          convergenceReady = undefined;
        }
      };
      return Promise.resolve({ ok: true, ready: true });
    } catch {
      return Promise.resolve(fixedFailure());
    }
  },

  async topicsDiagnosticsConvergencePublish({ channel }) {
    try {
      if (!aggregateOnlyDiagnostics || typeof channel !== "string") {
        return fixedFailure();
      }
      const entry = await privateTopicsConvergence();
      if (convergenceChannel) {
        convergenceEntries.push(entry);
        if (convergenceEntries.length === convergenceExpected) {
          convergenceReady?.();
          convergenceReady = undefined;
        }
        return fixedSuccess();
      }
      const broadcast = new BroadcastChannel(channel);
      const receipt = crypto.randomUUID();
      convergencePublishChannels.push(broadcast);
      await new Promise<void>((resolve) => {
        broadcast.onmessage = (event: MessageEvent<unknown>) => {
          if (isRecord(event.data) && event.data.ack === receipt) resolve();
        };
        broadcast.postMessage({ ...entry, receipt });
      });
      broadcast.close();
      convergencePublishChannels = convergencePublishChannels.filter((item) =>
        item !== broadcast
      );
      return fixedSuccess();
    } catch {
      return fixedFailure();
    }
  },

  topicsDiagnosticsConvergenceFinish() {
    try {
      if (!convergenceChannel) return Promise.resolve(fixedFailure());
      if (convergenceEntries.length !== convergenceExpected) {
        return Promise.resolve(fixedFailure());
      }
      const reference = convergenceEntries[0].token;
      const result = {
        ok: true as const,
        converged: convergenceEntries.every((entry) =>
          entry.token === reference
        ),
        summary: {
          topics: convergenceEntries.map((entry) => entry.topics),
          comments: convergenceEntries.map((entry) => entry.comments),
          links: convergenceEntries.map((entry) => entry.links),
        },
      };
      convergenceChannel.close();
      convergenceChannel = undefined;
      convergenceExpected = 0;
      convergenceEntries = [];
      for (const channel of convergencePublishChannels) channel.close();
      convergencePublishChannels = [];
      return Promise.resolve(result);
    } catch {
      return Promise.resolve(fixedFailure());
    }
  },

  topicsDiagnosticsConvergenceCancel() {
    try {
      closeTopicsChannels();
      return Promise.resolve(fixedSuccess());
    } catch {
      return Promise.resolve(fixedFailure());
    }
  },

  async topicsDiagnosticsSend({ target, event, idle }) {
    try {
      await syncResultTopology();
      await handlers.send({ target, event, idle });
      return { ok: true } satisfies TopicsDiagnosticsOperationOutcome;
    } catch {
      return topicsOperationFailure();
    }
  },

  // Faithful mirror of RuntimeProcessor.handleCellSet — the path a UI binding
  // takes for a plain `set`: ONE fresh edit tx, a single un-retried commit,
  // marked as renderer input plus a blind leaf write. The blind-vs-CAS choice is by METHOD, not value
  // shape: a `set` is ALWAYS blind (last-write-wins); read-modify-write goes
  // through `push` (below), which keeps compare-and-set. We await the commit so
  // the test can observe the outcome (a conflict surfaces as a Result error).
  // Pass `idle: false` to leave this runtime un-settled, so its local replica
  // stays stale (own-write-race repro).
  async set({ path, value, idle: doIdle }) {
    const runtime = controller().manager().runtime;
    const tx = runtime.edit();
    let cell = result();
    for (const segment of normalizePath(path ?? [], "set path", true)) {
      cell = cell.key(segment as never) as Cell<any>;
    }
    // Match RuntimeProcessor.handleCellSet: a blind `$value` write carries
    // renderer-input provenance so scheduler wake shaping remains faithful.
    markRendererInputTx(tx);
    markUiInputBlindWriteTx(tx);
    // Mirror handleCellSet: thread the cell's PARENT address as the structural
    // existence/shape precondition for the blind write.
    const link = cell.withTx(tx).resolveAsCell().getAsNormalizedFullLink();
    setBlindStructuralTarget(tx, {
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: link.path.slice(0, -1),
    });
    cell.withTx(tx).set(value as never);
    unmarkUiInputBlindWriteTx(tx);
    runtime.prepareTxForCommit(tx);
    const log = tx.getReactivityLog?.();
    const writeCounts = log
      ? classifyTelemetryWriteCounts(log.writes, log.attemptedWrites ?? [])
      : { writeCount: 0, changedWriteCount: 0 };
    const res = await tx.commit() as {
      error?: { name?: string; message?: string };
    };
    telemetry?.recordDirectCommit({
      readCount: log ? log.reads.length + log.shallowReads.length : 0,
      ...writeCounts,
      writes: log?.writes.map((write) => write.path.join("/")) ?? [],
      failed: res?.error !== undefined,
    });
    if (doIdle !== false) await idle();
    return sanitizeForTransfer({
      ok: !res?.error,
      error: res?.error
        ? { name: res.error.name, message: res.error.message }
        : undefined,
    });
  },

  async topicsDiagnosticsSet({ path, value, idle }) {
    try {
      await syncResultTopology();
      const outcome = await handlers.set({ path, value, idle }) as {
        ok: boolean;
      };
      return outcome.ok
        ? { ok: true } satisfies TopicsDiagnosticsOperationOutcome
        : topicsOperationFailure();
    } catch {
      return topicsOperationFailure();
    }
  },

  async topicsDiagnosticsNoop({ topicIndex, idle }) {
    try {
      if (
        typeof topicIndex !== "number" ||
        !Number.isSafeInteger(topicIndex) ||
        topicIndex < 0
      ) {
        return {
          ...topicsOperationFailure(),
          submitted: 0,
          directAccepted: 0,
          directRejected: 0,
        } satisfies TopicsDiagnosticsNoopOutcome;
      }
      await syncResultTopology();
      const title = topicsCell(["topics", topicIndex, "title"]);
      const body = topicsCell(["topics", topicIndex, "body"]);
      await Promise.all([title.sync(), body.sync()]);
      const [titleValue, bodyValue] = await Promise.all([
        title.pull(),
        body.pull(),
      ]);
      const setOutcome = await handlers.topicsDiagnosticsSet({
        path: ["topics", topicIndex, "title"],
        value: titleValue,
        idle,
      }) as TopicsDiagnosticsOperationOutcome;
      const sendOutcome = await handlers.topicsDiagnosticsSend({
        target: ["topics", topicIndex, "setBody"],
        event: { body: bodyValue, agentName: "Topics Diagnostics" },
        idle,
      }) as TopicsDiagnosticsOperationOutcome;
      const ok = setOutcome.ok && sendOutcome.ok;
      return {
        ...(ok ? { ok: true } : topicsOperationFailure()),
        submitted: 2,
        directAccepted: setOutcome.ok ? 1 : 0,
        directRejected: setOutcome.ok ? 0 : 1,
      } satisfies TopicsDiagnosticsNoopOutcome;
    } catch {
      return {
        ...topicsOperationFailure(),
        submitted: 0,
        directAccepted: 0,
        directRejected: 0,
      } satisfies TopicsDiagnosticsNoopOutcome;
    }
  },

  /**
   * Diagnostic-only whole-document replacement for one direct child of a
   * result document's `value` record. Unlike `set`, this deliberately writes
   * `['value']` through the transaction API, producing one root patch rather
   * than a recursive cell diff.
   */
  async prepareContainingDocumentValueRoot({ path, value, idle: doIdle }) {
    if (!diagnosticMutationsEnabled) {
      throw new Error(
        "containing-document root replacement requires a local diagnostics harness",
      );
    }
    if (pendingContainingDocumentRootCommit !== undefined) {
      throw new Error(
        "containing-document root replacement is already prepared",
      );
    }
    if (!Array.isArray(value)) {
      throw new Error(
        "containing-document root replacement value must be an array",
      );
    }
    const target = result();
    await target.pull();
    let cell = target;
    for (
      const segment of normalizePath(
        path ?? [],
        "containing-document root replacement path",
      )
    ) {
      cell = cell.key(segment as never) as Cell<any>;
    }
    const runtime = controller().manager().runtime;
    const tx = runtime.edit();
    const link = cell.withTx(tx).resolveAsCell().getAsNormalizedFullLink();
    // Normalized cell links are value-relative. Convert to the canonical
    // document-memory path before enforcing the direct-child constraint.
    const resolvedPath = ["value", ...link.path];
    if (
      resolvedPath.length !== 2 || resolvedPath[0] !== "value" ||
      typeof resolvedPath[1] !== "string"
    ) {
      throw new Error(
        "containing-document root replacement requires a direct string-key child of value",
      );
    }

    const address = {
      space: link.space,
      id: link.id,
      scope: link.scope,
      type: "application/json" as const,
      path: ["value"],
    };
    const containingValue = tx.readOrThrow(address);
    if (!isRecord(containingValue)) {
      throw new Error(
        "containing-document root replacement requires value to be a record",
      );
    }
    tx.writeOrThrow(address, {
      ...containingValue,
      [resolvedPath[1]]: value,
    });
    pendingContainingDocumentRootCommit = async () => {
      runtime.prepareTxForCommit(tx);
      const log = tx.getReactivityLog?.();
      const writeCounts = log
        ? classifyTelemetryWriteCounts(log.writes, log.attemptedWrites ?? [])
        : { writeCount: 0, changedWriteCount: 0 };
      const res = await tx.commit() as {
        error?: { name?: string; message?: string };
      };
      telemetry?.recordDirectCommit({
        readCount: log ? log.reads.length + log.shallowReads.length : 0,
        ...writeCounts,
        writes: log?.writes.map((write) => write.path.join("/")) ?? [],
        failed: res?.error !== undefined,
      });
      if (doIdle !== false) await idle();
      return sanitizeForTransfer({
        ok: !res?.error,
        error: res?.error
          ? { name: res.error.name, message: res.error.message }
          : undefined,
      });
    };
    return {};
  },

  async commitPreparedContainingDocumentValueRoot() {
    if (!diagnosticMutationsEnabled) {
      throw new Error(
        "containing-document root replacement requires a local diagnostics harness",
      );
    }
    const commit = pendingContainingDocumentRootCommit;
    if (commit === undefined) {
      throw new Error("no containing-document root replacement is prepared");
    }
    pendingContainingDocumentRootCommit = undefined;
    return await commit();
  },

  async topicsDiagnosticsPrepareReversedRoot({ idle }) {
    try {
      await syncResultTopology();
      const topics = topicsCell(["topics"]).resolveAsCell();
      await topics.sync();
      await topics.pull();
      const rawTopics = topics.getRaw();
      if (!Array.isArray(rawTopics) || rawTopics.length < 2) {
        return topicsOperationFailure();
      }
      await handlers.prepareContainingDocumentValueRoot({
        path: ["topics"],
        value: [...rawTopics].reverse(),
        idle,
      });
      return { ok: true } satisfies TopicsDiagnosticsOperationOutcome;
    } catch {
      return topicsOperationFailure();
    }
  },

  async topicsDiagnosticsCommitPreparedRoot() {
    try {
      const outcome = await handlers
        .commitPreparedContainingDocumentValueRoot({}) as {
          ok: boolean;
        };
      return outcome.ok
        ? { ok: true } satisfies TopicsDiagnosticsOperationOutcome
        : topicsOperationFailure();
    } catch {
      return topicsOperationFailure();
    }
  },

  // Faithful mirror of RuntimeProcessor.handleCellPush / CellHandle.push: a
  // read-modify-write append, NOT blind — the set's diff read of the current
  // array is kept as a commit precondition (compare-and-set), so a concurrent
  // push aborts rather than being clobbered by a blind overwrite. Reads the
  // current value from the local replica (no pull), mirroring CellHandle.push
  // reading its cache.
  async push({ path, value, idle: doIdle }) {
    const runtime = controller().manager().runtime;
    let cell = result();
    for (const segment of normalizePath(path ?? [], "push path", true)) {
      cell = cell.key(segment as never) as Cell<any>;
    }
    const currentRaw = cell.get();
    const current = Array.isArray(currentRaw) ? currentRaw : [];
    const tx = runtime.edit();
    cell.withTx(tx).set([...current, value] as never);
    runtime.prepareTxForCommit(tx);
    const log = tx.getReactivityLog?.();
    const writeCounts = log
      ? classifyTelemetryWriteCounts(log.writes, log.attemptedWrites ?? [])
      : { writeCount: 0, changedWriteCount: 0 };
    const res = await tx.commit() as {
      error?: { name?: string; message?: string };
    };
    telemetry?.recordDirectCommit({
      readCount: log ? log.reads.length + log.shallowReads.length : 0,
      ...writeCounts,
      writes: log?.writes.map((write) => write.path.join("/")) ?? [],
      failed: res?.error !== undefined,
    });
    if (doIdle !== false) await idle();
    return sanitizeForTransfer({
      ok: !res?.error,
      error: res?.error
        ? { name: res.error.name, message: res.error.message }
        : undefined,
    });
  },

  async read({ path, omitKeys }) {
    const normalizedPath = normalizePath(path ?? [], "read path", true);
    const cell = await syncResultTopology(normalizedPath);
    const value = await cell.pull();
    return sanitizeForTransfer(
      value,
      normalizeOmitKeys(omitKeys),
    );
  },

  /**
   * Read the RAW stored value of the cell reached from the piece result by
   * `path` (links resolved to the target cell, NO result-schema shaping) —
   * for state the declared schema does not carry, e.g. a query result's
   * `requestHash`. Nested links in the raw value stay sigils.
   */
  async readRaw({ path }) {
    const normalizedPath = normalizePath(path ?? [], "readRaw path", true);
    const cell = await syncResultTopology(normalizedPath);
    const resolved = cell.resolveAsCell();
    await resolved.sync();
    await resolved.pull();
    return sanitizeForTransfer(resolved.getRaw());
  },

  /**
   * Inspect the normalized link (id, space, scope) of a cell reached from
   * the piece result by `path`, resolving links along the way. Lets tests
   * assert the storage addressing (e.g. scope) of pattern state.
   */
  async link({ path }) {
    const normalizedPath = normalizePath(path ?? [], "link path", true);
    const cell = await syncResultTopology(normalizedPath);
    const resolved = cell.resolveAsCell();
    await resolved.sync();
    await resolved.pull();
    const link = resolved.getAsNormalizedFullLink();
    return sanitizeForTransfer({
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: link.path,
    });
  },

  async topicsDiagnosticsCreateCrossref({ sourceIndex, targetIndex, idle }) {
    try {
      if (
        typeof sourceIndex !== "number" ||
        !Number.isSafeInteger(sourceIndex) || sourceIndex < 0 ||
        typeof targetIndex !== "number" ||
        !Number.isSafeInteger(targetIndex) || targetIndex < 0
      ) return topicsOperationFailure();
      await syncResultTopology();
      const target = topicsCell(["topics", targetIndex]).resolveAsCell();
      await target.sync();
      await target.pull();
      const fid = /fid1:[A-Za-z0-9_-]+/.exec(
        target.getAsNormalizedFullLink().id,
      )?.[0];
      if (!fid) return topicsOperationFailure();
      return await handlers.topicsDiagnosticsSend({
        target: ["topics", sourceIndex, "setBody"],
        event: { body: `Reference ${fid}`, agentName: "Topics Diagnostics" },
        idle,
      }) as TopicsDiagnosticsOperationOutcome;
    } catch {
      return topicsOperationFailure();
    }
  },

  async topicsDiagnosticsValidateCrossrefs({ topicCount }) {
    try {
      if (
        typeof topicCount !== "number" ||
        !Number.isSafeInteger(topicCount) ||
        topicCount < 2
      ) {
        return {
          ok: false,
          validatedSources: 0,
        } satisfies TopicsDiagnosticsCrossrefValidation;
      }
      await idle();
      const target = await syncResultTopology(["crossrefs", 0, "topic"]);
      await target.pull();
      const sources: Cell<any>[] = [];
      let validatedSources = 0;
      for (let index = 1; index < topicCount; index++) {
        const refsOut = await syncResultTopology([
          "crossrefs",
          index,
          "refsOut",
        ]);
        const values = await refsOut.pull();
        if (!Array.isArray(values) || values.length !== 1) {
          return { ok: false, validatedSources: index - 1 };
        }
        const referenced = refsOut.key(0).resolveAsCell();
        await referenced.pull();
        if (!referenced.equals(target)) {
          return { ok: false, validatedSources: index - 1 };
        }
        const source = await syncResultTopology([
          "crossrefs",
          index,
          "topic",
        ]);
        await source.pull();
        sources.push(source);
        validatedSources++;
      }
      const referencedBy = await syncResultTopology([
        "crossrefs",
        0,
        "referencedBy",
      ]);
      const backlinks = await referencedBy.pull();
      if (!Array.isArray(backlinks) || backlinks.length !== topicCount - 1) {
        return { ok: false, validatedSources };
      }
      for (const [index] of backlinks.entries()) {
        const backlink = referencedBy.key(index).resolveAsCell();
        await backlink.pull();
        if (!backlink.equals(sources[index])) {
          return { ok: false, validatedSources };
        }
      }
      return {
        ok: true,
        validatedSources,
      } satisfies TopicsDiagnosticsCrossrefValidation;
    } catch {
      return {
        ok: false,
        validatedSources: 0,
      } satisfies TopicsDiagnosticsCrossrefValidation;
    }
  },

  // Raw replica read: a storage-transaction read at an explicit address,
  // bypassing the piece result / schema / link-following path entirely. Lets a
  // test distinguish "this runtime's replica never received the doc" from
  // "the doc is in the replica but the schema-aware read fails to resolve it".
  async rawRead({ id, space, path, scope }) {
    const runtime = controller().manager().runtime;
    const tx = runtime.edit();
    const res = tx.read({
      space: space as never,
      id: id as never,
      type: "application/json",
      path: (path ?? []) as string[],
      ...(scope !== undefined ? { scope: scope as never } : {}),
    } as never) as { ok?: { value?: unknown }; error?: { message?: string } };
    await tx.commit();
    return sanitizeForTransfer({
      ok: res.error === undefined,
      value: res.ok?.value,
      error: res.error?.message,
    });
  },

  async idle() {
    await idle();
    return {};
  },

  async settled() {
    await settled();
    return {};
  },

  async delayedFramesDrained() {
    await awaitDelayedFramesDrained();
    return {};
  },

  async diagnostics({ idle: doIdle } = {}) {
    if (doIdle !== false) await idle();
    const scheduler = controller().manager().runtime.scheduler;
    return sanitizeForTransfer(
      {
        graph: scheduler.getGraphSnapshot(),
        settleStatsHistory: scheduler.getSettleStatsHistory(),
        actionRunTrace: scheduler.getActionRunTrace(),
      } satisfies RuntimeDiagnosticsSnapshot,
    );
  },

  async diagnosticsSummary({ idle: doIdle } = {}) {
    if (doIdle !== false) await idle();
    const scheduler = controller().manager().runtime.scheduler;
    const graph = scheduler.getGraphSnapshot();
    const settleStatsHistory = scheduler.getSettleStatsHistory();
    return {
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      dirtyNodeCount: graph.nodes.filter((node) => node.isDirty).length,
      pendingNodeCount: graph.nodes.filter((node) => node.isPending).length,
      settleHistoryEntryCount: settleStatsHistory.length,
      maxTrailingSettleDurationMs: trailingSettleDuration(settleStatsHistory),
    } satisfies RuntimeDiagnosticsSummary;
  },

  async topicsDiagnosticsChurn({ idle: doIdle } = {}) {
    if (doIdle !== false) await idle();
    const storage = getLoggerCountsBreakdown()["storage.v2"] ?? {};
    return {
      commitConflicts: storage["commit-conflict"]?.total ?? 0,
      commitPreempted: storage["commit-preempted"]?.total ?? 0,
      commitHeldRevert: storage["commit-held-revert"]?.total ?? 0,
      commitHeldSent: storage["commit-held-sent"]?.total ?? 0,
      commitReverts: storage["commit-revert"]?.total ?? 0,
      commitRejected: storage["commit-rejected"]?.total ?? 0,
    } satisfies TopicsDiagnosticsChurnTotals;
  },

  diagnosticsActivityGeneration() {
    return Promise.resolve({ generation: diagnosticsActivityGeneration });
  },

  telemetry() {
    if (!telemetry) {
      throw new Error("runtime telemetry requires diagnostics: true");
    }
    return Promise.resolve(sanitizeForTransfer(telemetry.snapshotAndReset()));
  },

  async loggerCounts({ idle: doIdle } = {}) {
    if (doIdle !== false) await idle();
    return getLoggerCountsBreakdown();
  },

  async dispose() {
    const aggregate = aggregateOnlyDiagnostics;
    try {
      pendingContainingDocumentRootCommit = undefined;
      closeTopicsChannels();
      resultSinkCancel?.();
      resultSinkCancel = undefined;
      if (telemetryListener && cc) {
        cc.manager().runtime.telemetry.removeEventListener(
          "telemetry",
          telemetryListener,
        );
      }
      telemetryListener = undefined;
      releaseDetailedEventCommitTelemetry?.();
      releaseDetailedEventCommitTelemetry = undefined;
      telemetry = undefined;
      piece = undefined;
      if (cc) {
        await cc.dispose();
        cc = undefined;
      }
      return aggregate ? fixedSuccess() : {};
    } catch {
      return aggregate ? fixedFailure() : {};
    } finally {
      diagnosticsEnabled = false;
      aggregateOnlyDiagnostics = false;
      aggregateBootstrapCreator = false;
      aggregateBootstrapChannel = undefined;
      aggregateBootstrapParticipants = 0;
      diagnosticMutationsEnabled = false;
      diagnosticsActivityGeneration = 0;
      if (!aggregate) restoreAggregateConsole?.();
    }
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const aggregateOnlyCommands = new Set([
  "init",
  "createPiece",
  "idle",
  "settled",
  "delayedFramesDrained",
  "diagnosticsSummary",
  "diagnosticsActivityGeneration",
  "telemetry",
  "dispose",
  "topicsDiagnosticsChurn",
  "topicsDiagnosticsSummary",
  "topicsDiagnosticsPrepareBootstrap",
  "topicsDiagnosticsFinishBootstrap",
  "topicsDiagnosticsConvergenceBegin",
  "topicsDiagnosticsConvergencePublish",
  "topicsDiagnosticsConvergenceFinish",
  "topicsDiagnosticsConvergenceCancel",
  "topicsDiagnosticsSend",
  "topicsDiagnosticsSet",
  "topicsDiagnosticsNoop",
  "topicsDiagnosticsPrepareReversedRoot",
  "topicsDiagnosticsCommitPreparedRoot",
  "topicsDiagnosticsCreateCrossref",
  "topicsDiagnosticsValidateCrossrefs",
]);

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, cmd, args } = event.data;
  const handler = handlers[cmd];
  const respond = (response: WorkerResponse) =>
    (self as unknown as Worker).postMessage(response);
  if (aggregateOnlyDiagnostics && !aggregateOnlyCommands.has(cmd)) {
    respond({ id, error: "operation-failed" });
    return;
  }
  if (!handler) {
    respond({ id, error: `unknown command "${cmd}"` });
    return;
  }
  handler(args).then(
    (ok) => respond({ id, ok }),
    (error: unknown) =>
      respond({
        id,
        error: aggregateOnlyDiagnostics
          ? "operation-failed"
          : error instanceof Error
          ? `${error.message}\n${error.stack ?? ""}`
          : String(error),
      }),
  );
};
