/**
 * RuntimeWorker - Main thread controller for the worker-based Runtime
 *
 * This class manages a web worker that runs the Runtime, providing a clean API
 * for interacting with cells across the worker boundary.
 *
 * Events:
 * - "console": Fired when code in the worker logs to the console
 * - "navigate": Fired when a recipe calls navigateTo()
 * - "error": Fired when an error occurs during recipe execution
 */

import type { Identity } from "@commontools/identity";
import type { DID } from "@commontools/identity";
import { defer, type Deferred } from "@commontools/utils/defer";
import type { JSONSchema } from "../builder/types.ts";
import type { SigilLink, URI } from "../sigil-types.ts";
import type { MemorySpace } from "../storage/interface.ts";
import { RemoteCell } from "./cell-handle.ts";
import {
  createSigilLinkFromParsedLink,
  isSigilLink,
  type NormalizedLink,
} from "../link-utils.ts";
import {
  type BaseResponse,
  type CellRef,
  type CharmCreateResponse as CharmCreateFromUrlResponse,
  type CharmGetAllResponse,
  type CharmGetResponse,
  type GetCellResponse,
  isCellUpdateNotification,
  isConsoleMessageNotification,
  isErrorReportNotification,
  isNavigateRequestNotification,
  isReadyResponse,
  isWorkerIPCResponse,
  RuntimeWorkerMessageType,
} from "./ipc-protocol.ts";
import { Program } from "@commontools/js-compiler";

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Worker state machine states
 */
export enum RuntimeWorkerState {
  Uninitialized = "uninitialized",
  Initializing = "initializing",
  Ready = "ready",
  Terminating = "terminating",
  Terminated = "terminated",
  Error = "error",
}

/**
 * Console event detail
 */
export interface RuntimeWorkerConsoleDetail {
  metadata?: { charmId?: string; recipeId?: string; space?: string };
  method: string;
  args: unknown[];
}

/**
 * Navigate event detail
 */
export interface RuntimeWorkerNavigateDetail {
  target: RemoteCell<unknown>;
}

/**
 * Error event detail
 */
export interface RuntimeWorkerErrorDetail {
  message: string;
  charmId?: string;
  space?: string;
  recipeId?: string;
  spellId?: string;
}

/**
 * Custom event types for RuntimeWorker
 */
export type RuntimeWorkerConsoleEvent = CustomEvent<RuntimeWorkerConsoleDetail>;
export type RuntimeWorkerNavigateEvent = CustomEvent<
  RuntimeWorkerNavigateDetail
>;
export type RuntimeWorkerErrorEvent = CustomEvent<RuntimeWorkerErrorDetail>;

/**
 * Event map for RuntimeWorker
 */
export interface RuntimeWorkerEventMap {
  console: RuntimeWorkerConsoleEvent;
  navigate: RuntimeWorkerNavigateEvent;
  error: RuntimeWorkerErrorEvent;
}

/**
 * Configuration options for RuntimeWorker
 */
export interface RuntimeWorkerOptions {
  /** API URL for the toolshed */
  apiUrl: URL;
  /** User identity for authentication */
  identity: Identity;
  /** Optional, temporary identity of space */
  spaceIdentity?: Identity;
  /** space DID to connect to */
  spaceDid: DID;
  /** Optional space name */
  spaceName?: string;
  /** Request timeout in milliseconds (default: 60000) */
  timeoutMs?: number;
  /** URL to hosted `worker-runtime.ts` */
  workerUrl: URL;
}

/**
 * Pending request tracking
 */
interface PendingRequest<T = unknown> {
  msgId: number;
  type: RuntimeWorkerMessageType;
  startTime: number;
  deferred: Deferred<T, Error>;
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * RuntimeWorker provides a main-thread interface to a Runtime running in a web worker.
 *
 * This keeps heavy computation off the main thread while providing transparent
 * access to cells via RemoteCell objects.
 *
 * Extends EventTarget to emit events for console messages, navigation requests,
 * and errors from recipes running in the worker.
 */
export class RuntimeWorker extends EventTarget {
  private _worker: Worker;
  private _state: RuntimeWorkerState = RuntimeWorkerState.Uninitialized;
  private _pendingRequests = new Map<number, PendingRequest>();
  private _subscriptions = new Map<string, (value: unknown) => void>();
  private _nextMsgId = 0;
  private _timeoutMs: number;
  private _initializePromise: Promise<void>;
  private _initializeDeferred = defer<void>();
  private readonly _options: RuntimeWorkerOptions;
  constructor(options: RuntimeWorkerOptions) {
    super();
    this._timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._worker = new Worker(
      options.workerUrl,
      {
        type: "module",
        name: "runtime-worker",
      },
    );
    this._options = options;
    this._worker.addEventListener("message", this._handleMessage);
    this._worker.addEventListener("error", this._handleError);
    this._initializePromise = this._initialize().catch(console.error);
  }

  private async _initialize(): Promise<void> {
    // Wait for worker ready signal
    await this._waitForReady();

    this._state = RuntimeWorkerState.Initializing;

    try {
      await this._sendRequest({
        type: RuntimeWorkerMessageType.Initialize,
        data: {
          apiUrl: this._options.apiUrl.toString(),
          identity: this._options.identity.serialize(),
          spaceIdentity: this._options.spaceIdentity?.serialize(),
          spaceDid: this._options.spaceDid,
          spaceName: this._options.spaceName,
        },
      });

      this._state = RuntimeWorkerState.Ready;
      this._initializeDeferred.resolve();
    } catch (error) {
      this._state = RuntimeWorkerState.Error;
      this._initializeDeferred.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  /**
   * Wait for the worker to signal ready
   */
  private _waitForReady(): Promise<void> {
    return new Promise((resolve) => {
      const handler = (event: MessageEvent) => {
        if (event.data?.type === RuntimeWorkerMessageType.Ready) {
          this._worker.removeEventListener("message", handler);
          resolve();
        }
      };
      this._worker.addEventListener("message", handler);
    });
  }

  /**
   * Wait for the worker to be ready.
   * Call this before using any other methods.
   */
  ready(): Promise<void> {
    return this._initializePromise;
  }

  /**
   * Check if the worker is ready
   */
  isReady(): boolean {
    return this._state === RuntimeWorkerState.Ready;
  }

  /**
   * Get the current worker state
   */
  get state(): RuntimeWorkerState {
    return this._state;
  }

  /**
   * Get a cell proxy from a SigilLink or NormalizedLink.
   * This is the most common way to access cells from the main thread.
   */
  getCellFromLink<T>(
    link: SigilLink | NormalizedLink,
    schema?: JSONSchema,
  ): RemoteCell<T> {
    const sigilLink = isSigilLink(link)
      ? link
      : createSigilLinkFromParsedLink(link);
    const cellRef: CellRef = { link: sigilLink, schema };
    return new RemoteCell<T>(this, cellRef);
  }

  /**
   * Get a cell proxy from an entity ID.
   */
  getCellFromEntityId<T>(
    space: MemorySpace,
    entityId: URI,
    path?: string[],
    schema?: JSONSchema,
  ): RemoteCell<T> {
    // Create a provisional proxy that will be validated on first access
    const cellRef: CellRef = {
      link: {
        "/": {
          "link@1": {
            id: entityId,
            path,
            space,
            schema,
          },
        },
      },
      schema,
    };
    return new RemoteCell<T>(this, cellRef);
  }

  /**
   * Get a new cell with cause (async, needs to call worker).
   */
  async getCell<T>(
    space: MemorySpace,
    cause: unknown,
    schema?: JSONSchema,
  ): Promise<RemoteCell<T>> {
    await this.ready();

    const response = await this._sendRequest<GetCellResponse>({
      type: RuntimeWorkerMessageType.GetCell,
      space,
      cause,
      schema,
    });

    return new RemoteCell<T>(this, response.cellRef);
  }

  /**
   * Wait for all pending operations to complete.
   */
  async idle(): Promise<void> {
    await this.ready();
    await this._sendRequest({ type: RuntimeWorkerMessageType.Idle });
  }

  // ============================================================================
  // Charm operations
  // ============================================================================

  /**
   * Create a new charm from a URL entry.
   * Returns a RemoteCell for the charm's main cell.
   */
  async createCharmFromUrl<T>(
    entryUrl: URL,
    options?: { argument?: unknown; run?: boolean },
  ): Promise<{ id: string; cell: RemoteCell<T> }> {
    await this.ready();

    const response = await this._sendRequest<CharmCreateFromUrlResponse>({
      type: RuntimeWorkerMessageType.CharmCreateFromUrl,
      entryUrl: entryUrl.href,
      argument: options?.argument,
      run: options?.run,
    });

    return {
      id: response.charm.id,
      cell: new RemoteCell<T>(this, response.charm.cellRef),
    };
  }

  /**
   * Create a new charm from a Program.
   * Returns a RemoteCell for the charm's main cell.
   */
  async createCharmFromProgram<T>(
    program: Program,
    options?: { argument?: unknown; run?: boolean },
  ): Promise<{ id: string; cell: RemoteCell<T> }> {
    await this.ready();

    const response = await this._sendRequest<CharmCreateFromUrlResponse>({
      type: RuntimeWorkerMessageType.CharmCreateFromProgram,
      program,
      argument: options?.argument,
      run: options?.run,
    });

    return {
      id: response.charm.id,
      cell: new RemoteCell<T>(this, response.charm.cellRef),
    };
  }

  async runCharmSynced(
    charmId: string,
  ): Promise<{ id: string; cell: RemoteCell } | null> {
    await this.ready();
    const response = await this._sendRequest<CharmGetResponse>({
      type: RuntimeWorkerMessageType.CharmSyncPattern,
      charmId,
    });
    if (!response.charm) return null;
    return {
      id: response.charm.id,
      cell: new RemoteCell(this, response.charm.cellRef),
    };
  }

  /**
   * Get a charm by ID.
   * Returns null if the charm doesn't exist.
   */
  async getCharm<T>(
    charmId: string,
    runIt?: boolean,
  ): Promise<{ id: string; cell: RemoteCell<T> } | null> {
    await this.ready();

    const response = await this._sendRequest<CharmGetResponse>({
      type: RuntimeWorkerMessageType.CharmGet,
      charmId,
      runIt,
    });

    if (!response.charm) return null;

    return {
      id: response.charm.id,
      cell: new RemoteCell<T>(this, response.charm.cellRef),
    };
  }

  /**
   * Remove a charm from the space.
   */
  async removeCharm(charmId: string): Promise<void> {
    await this.ready();
    await this._sendRequest({
      type: RuntimeWorkerMessageType.CharmRemove,
      charmId,
    });
  }

  /**
   * Start a charm's execution.
   */
  async startCharm(charmId: string): Promise<void> {
    await this.ready();
    await this._sendRequest({
      type: RuntimeWorkerMessageType.CharmStart,
      charmId,
    });
  }

  /**
   * Stop a charm's execution.
   */
  async stopCharm(charmId: string): Promise<void> {
    await this.ready();
    await this._sendRequest({
      type: RuntimeWorkerMessageType.CharmStop,
      charmId,
    });
  }

  /**
   * Get the charms list cell.
   * Subscribe to this cell to get reactive updates of all charms in the space.
   */
  async getCharmsListCell<T>(): Promise<RemoteCell<T[]>> {
    await this.ready();

    const response = await this._sendRequest<CharmGetAllResponse>({
      type: RuntimeWorkerMessageType.CharmGetAll,
    });

    return new RemoteCell<T[]>(this, response.charmsListCellRef);
  }

  /**
   * Wait for the CharmManager to be synced with storage.
   */
  async synced(): Promise<void> {
    await this.ready();
    await this._sendRequest({ type: RuntimeWorkerMessageType.CharmSynced });
  }

  /**
   * Dispose of the worker and clean up resources.
   */
  async dispose(): Promise<void> {
    if (
      this._state === RuntimeWorkerState.Terminating ||
      this._state === RuntimeWorkerState.Terminated
    ) {
      return;
    }

    this._state = RuntimeWorkerState.Terminating;

    // Reject all pending requests
    for (const pending of this._pendingRequests.values()) {
      clearTimeout(pending.timeoutId);
      pending.deferred.reject(new Error("RuntimeWorker disposing"));
    }
    this._pendingRequests.clear();

    // Clear subscriptions
    this._subscriptions.clear();

    // Request graceful shutdown
    try {
      await this._sendRequest(
        { type: RuntimeWorkerMessageType.Dispose },
        5000, // Short timeout for dispose
      );
    } catch {
      // Ignore errors during dispose
    }

    // Terminate worker
    this._worker.terminate();
    this._state = RuntimeWorkerState.Terminated;
  }

  async [Symbol.asyncDispose]() {
    await this.dispose();
  }

  // ============================================================================
  // Internal methods used by RemoteCell
  // ============================================================================

  /**
   * Send a request to the worker and return the response.
   * @internal
   */
  async sendRequest<R extends BaseResponse>(
    request: { type: RuntimeWorkerMessageType } & Record<string, unknown>,
  ): Promise<R> {
    await this.ready();
    return this._sendRequest<R>(request);
  }

  /**
   * Subscribe to cell updates from the worker.
   * @internal
   */
  subscribe(
    subscriptionId: string,
    cellRef: CellRef,
    callback: (value: unknown) => void,
  ): void {
    this._subscriptions.set(subscriptionId, callback);

    // Send subscription request (fire and forget)
    this._sendRequest({
      type: RuntimeWorkerMessageType.CellSubscribe,
      cellRef,
      subscriptionId,
    }).catch((error) => {
      console.error("[RuntimeWorker] Subscription failed:", error);
      this._subscriptions.delete(subscriptionId);
    });
  }

  /**
   * Unsubscribe from cell updates.
   * @internal
   */
  unsubscribe(subscriptionId: string): void {
    this._subscriptions.delete(subscriptionId);

    // Send unsubscription request (fire and forget)
    this._sendRequest({
      type: RuntimeWorkerMessageType.CellUnsubscribe,
      subscriptionId,
    }).catch((error) => {
      console.error("[RuntimeWorker] Unsubscribe failed:", error);
    });
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private _sendRequest<R extends BaseResponse>(
    request: { type: RuntimeWorkerMessageType } & Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<R> {
    const timeout = timeoutMs ?? this._timeoutMs;
    const msgId = this._nextMsgId++;
    const message = { ...request, msgId };

    const deferred = defer<R, Error>();

    const timeoutId = setTimeout(() => {
      this._pendingRequests.delete(msgId);
      deferred.reject(
        new Error(`RuntimeWorker request timed out: ${request.type}`),
      );
    }, timeout);

    const pending: PendingRequest<R> = {
      msgId,
      type: request.type,
      startTime: performance.now(),
      deferred,
      timeoutId,
    };

    this._pendingRequests.set(msgId, pending as PendingRequest);
    this._worker.postMessage(message);

    return deferred.promise;
  }

  private _handleMessage = (event: MessageEvent): void => {
    const data = event.data;

    if (isCellUpdateNotification(data)) {
      const callback = this._subscriptions.get(data.subscriptionId);
      if (callback) {
        callback(data.value);
      }
      return;
    }

    if (isConsoleMessageNotification(data)) {
      this.dispatchEvent(
        new CustomEvent("console", {
          detail: {
            metadata: data.metadata,
            method: data.method,
            args: data.args,
          } satisfies RuntimeWorkerConsoleDetail,
        }),
      );
      return;
    }

    if (isNavigateRequestNotification(data)) {
      const target = new RemoteCell(this, data.targetCellRef);
      this.dispatchEvent(
        new CustomEvent("navigate", {
          detail: {
            target,
          } satisfies RuntimeWorkerNavigateDetail,
        }),
      );
      return;
    }

    if (isErrorReportNotification(data)) {
      this.dispatchEvent(
        new CustomEvent("error", {
          detail: {
            message: data.message,
            charmId: data.charmId,
            space: data.space,
            recipeId: data.recipeId,
            spellId: data.spellId,
          } satisfies RuntimeWorkerErrorDetail,
        }),
      );
      return;
    }

    // Handle ready signal (handled in _waitForReady)
    if (isReadyResponse(data)) {
      return;
    }

    // Handle request responses
    if (!isWorkerIPCResponse(data)) {
      console.warn("[RuntimeWorker] Invalid response:", data);
      return;
    }

    const pending = this._pendingRequests.get(data.msgId);
    if (!pending) {
      console.warn(
        "[RuntimeWorker] Response for unknown request:",
        data.msgId,
      );
      return;
    }

    clearTimeout(pending.timeoutId);
    this._pendingRequests.delete(data.msgId);

    if (data.error) {
      pending.deferred.reject(new Error(data.error));
    } else {
      pending.deferred.resolve(data);
    }
  };

  private _handleError = (event: ErrorEvent): void => {
    console.error("[RuntimeWorker] Worker error:", event);
    event.preventDefault();

    this._state = RuntimeWorkerState.Error;

    // Reject all pending requests
    for (const pending of this._pendingRequests.values()) {
      clearTimeout(pending.timeoutId);
      pending.deferred.reject(
        new Error(`RuntimeWorker error: ${event.message}`),
      );
    }
    this._pendingRequests.clear();

    // Terminate worker
    this._worker.terminate();
  };
}
