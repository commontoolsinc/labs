/**
 * Worker-side runtime host for the multi-runtime harness.
 *
 * Each worker owns ONE full client stack — Identity, StorageManager, Runtime,
 * PiecesController — in its own JS realm, exactly like one browser tab. The
 * main thread orchestrates via a tiny request/response protocol.
 */

import type { Cell } from "@commonfabric/runner";
import type { SchedulerGraphSnapshot } from "@commonfabric/runner";
import {
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

let cc: PiecesController | undefined;
let piece: PieceController | undefined;
let resultSchema: unknown;
let resultSinkCancel: (() => void) | undefined;

function controller(): PiecesController {
  if (!cc) throw new Error("worker not initialized");
  return cc;
}

function currentPiece(): PieceController {
  if (!piece) throw new Error("no piece attached");
  return piece;
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
function sanitizeForTransfer(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value, (_key, entry) => {
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
    ws.addEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === "message" && listener) listeners.add(listener);
      else if (listener) nativeAdd(type, listener, options);
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
      setTimeout(deliver, delayMs);
    });
    const nativeSend = ws.send.bind(ws);
    ws.send = (data: Parameters<WebSocket["send"]>[0]) => {
      setTimeout(() => {
        try {
          nativeSend(data);
        } catch {
          // Socket closed while the frame was in flight; same as a network drop.
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

const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  async init({ rawIdentity, spaceName, apiUrl, diagnostics, wsDelayMs }) {
    const identity = await Identity.deserialize(rawIdentity as KeyPairRaw);
    if (typeof wsDelayMs === "number") installWsDelay(wsDelayMs);
    cc = await initializePiecesController({
      apiUrl: new URL(apiUrl as string),
      identity,
      spaceName: spaceName as string,
    });
    if (diagnostics === true) {
      const scheduler = controller().manager().runtime.scheduler;
      scheduler.enableSettleStats();
      scheduler.setActionRunTraceEnabled(true);
    }
    return { did: identity.did() };
  },

  async createPiece({ programPath, rootPath, input }) {
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
    return { pieceId: created.id };
  },

  async openPiece({ pieceId }) {
    await attachPiece(await controller().get(pieceId as string, true));
    await idle();
    return {};
  },

  async send({ handler, event, trustedUi, idle: doIdle }) {
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
    const target = result();
    const { error } = await controller().manager().runtime.editWithRetry(
      (tx) => {
        target.key(handler as never).withTx(tx).send(eventValue as never);
      },
    );
    if (error) {
      throw new Error(`send "${handler}" failed: ${error.message}`);
    }
    // `idle: false` returns as soon as the event is queued, leaving the action
    // run + commit in flight — lets a test stack several sends into a deep
    // optimistic pipeline (the multiplayer-contention shape) instead of
    // serializing one settled commit per event.
    if (doIdle !== false) await idle();
    return {};
  },

  // Faithful mirror of RuntimeProcessor.handleCellSet — the path a UI binding
  // takes for a plain `set`: ONE fresh edit tx, a single un-retried commit,
  // marked as a blind leaf write. The blind-vs-CAS choice is by METHOD, not value
  // shape: a `set` is ALWAYS blind (last-write-wins); read-modify-write goes
  // through `push` (below), which keeps compare-and-set. We await the commit so
  // the test can observe the outcome (a conflict surfaces as a Result error).
  // Pass `idle: false` to leave this runtime un-settled, so its local replica
  // stays stale (own-write-race repro).
  async set({ path, value, idle: doIdle }) {
    const runtime = controller().manager().runtime;
    const tx = runtime.edit();
    let cell = result();
    for (const segment of (path ?? []) as (string | number)[]) {
      cell = cell.key(segment as never) as Cell<any>;
    }
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
    const res = await tx.commit() as {
      error?: { name?: string; message?: string };
    };
    if (doIdle !== false) await idle();
    return sanitizeForTransfer({
      ok: !res?.error,
      error: res?.error
        ? { name: res.error.name, message: res.error.message }
        : undefined,
    });
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
    for (const segment of (path ?? []) as (string | number)[]) {
      cell = cell.key(segment as never) as Cell<any>;
    }
    const currentRaw = cell.get();
    const current = Array.isArray(currentRaw) ? currentRaw : [];
    const tx = runtime.edit();
    cell.withTx(tx).set([...current, value] as never);
    runtime.prepareTxForCommit(tx);
    const res = await tx.commit() as {
      error?: { name?: string; message?: string };
    };
    if (doIdle !== false) await idle();
    return sanitizeForTransfer({
      ok: !res?.error,
      error: res?.error
        ? { name: res.error.name, message: res.error.message }
        : undefined,
    });
  },

  async read({ path }) {
    const target = result();
    await target.pull();
    let cell = target;
    for (const segment of (path ?? []) as (string | number)[]) {
      cell = cell.key(segment as never);
    }
    return sanitizeForTransfer(cell.get());
  },

  /**
   * Read the RAW stored value of the cell reached from the piece result by
   * `path` (links resolved to the target cell, NO result-schema shaping) —
   * for state the declared schema does not carry, e.g. a query result's
   * `requestHash`. Nested links in the raw value stay sigils.
   */
  async readRaw({ path }) {
    const target = result();
    await target.pull();
    let cell = target;
    for (const segment of (path ?? []) as (string | number)[]) {
      cell = cell.key(segment as never);
    }
    return sanitizeForTransfer(cell.resolveAsCell().getRaw());
  },

  /**
   * Inspect the normalized link (id, space, scope) of a cell reached from
   * the piece result by `path`, resolving links along the way. Lets tests
   * assert the storage addressing (e.g. scope) of pattern state.
   */
  async link({ path }) {
    const target = result();
    await target.pull();
    let cell = target;
    for (const segment of (path ?? []) as (string | number)[]) {
      cell = cell.key(segment as never);
    }
    const resolved = cell.resolveAsCell();
    const link = resolved.getAsNormalizedFullLink();
    return sanitizeForTransfer({
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: link.path,
    });
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

  async diagnostics() {
    await idle();
    const scheduler = controller().manager().runtime.scheduler;
    return sanitizeForTransfer(
      {
        graph: scheduler.getGraphSnapshot(),
        settleStatsHistory: scheduler.getSettleStatsHistory(),
        actionRunTrace: scheduler.getActionRunTrace(),
      } satisfies RuntimeDiagnosticsSnapshot,
    );
  },

  async loggerCounts() {
    await idle();
    return getLoggerCountsBreakdown();
  },

  async dispose() {
    resultSinkCancel?.();
    resultSinkCancel = undefined;
    piece = undefined;
    if (cc) {
      await cc.dispose();
      cc = undefined;
    }
    return {};
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, cmd, args } = event.data;
  const handler = handlers[cmd];
  const respond = (response: WorkerResponse) =>
    (self as unknown as Worker).postMessage(response);
  if (!handler) {
    respond({ id, error: `unknown command "${cmd}"` });
    return;
  }
  handler(args).then(
    (ok) => respond({ id, ok }),
    (error: unknown) =>
      respond({
        id,
        error: error instanceof Error
          ? `${error.message}\n${error.stack ?? ""}`
          : String(error),
      }),
  );
};
