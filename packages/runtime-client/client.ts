/**
 * RuntimeClient - Main thread controller for the worker-based Runtime
 *
 * This class manages a web worker that runs the Runtime, providing a clean API
 * for interacting with cells across the worker boundary.
 *
 * Events:
 * - "console": Fired when code in the worker logs to the console
 * - "navigate": Fired when a recipe calls navigateTo()
 * - "error": Fired when an error occurs during recipe execution
 */

import type { DID, Identity } from "@commontools/identity";
import { defer, type Deferred } from "@commontools/utils/defer";
import type { JSONSchema } from "@commontools/runner/shared";
import { Program } from "@commontools/js-compiler/interface";
import { isDeno } from "@commontools/utils/env";
import { CellHandle } from "./cell-handle.ts";
import {
  type BaseResponse,
  type CellRef,
  type CharmGetAllResponse,
  type CharmGetResponse,
  type CharmResultResponse,
  type GetCellResponse,
  InitializationData,
  isCellUpdateNotification,
  isConsoleMessageNotification,
  isErrorReportNotification,
  isNavigateRequestNotification,
  isReadyResponse,
  isWorkerIPCResponse,
  RuntimeClientMessageType,
  SubscriptionId,
} from "./ipc.ts";
import { NameSchema } from "@commontools/runner/schemas";

const DEBUG_IPC = true;
const DEFAULT_TIMEOUT_MS = 60_000;

export enum RuntimeClientState {
  Uninitialized = "uninitialized",
  Initializing = "initializing",
  Ready = "ready",
  Terminating = "terminating",
  Terminated = "terminated",
  Error = "error",
}

export interface RuntimeClientConsoleDetail {
  metadata?: { charmId?: string; recipeId?: string; space?: string };
  method: string;
  args: unknown[];
}

export interface RuntimeClientNavigateDetail {
  target: CellHandle<unknown>;
}

export interface RuntimeClientErrorDetail {
  message: string;
  charmId?: string;
  space?: string;
  recipeId?: string;
  spellId?: string;
}

export type RuntimeClientConsoleEvent = CustomEvent<RuntimeClientConsoleDetail>;
export type RuntimeClientNavigateEvent = CustomEvent<
  RuntimeClientNavigateDetail
>;
export type RuntimeClientErrorEvent = CustomEvent<RuntimeClientErrorDetail>;

export interface RuntimeClientEventMap {
  console: RuntimeClientConsoleEvent;
  navigate: RuntimeClientNavigateEvent;
  error: RuntimeClientErrorEvent;
}

export interface RuntimeClientOptions
  extends Omit<InitializationData, "apiUrl" | "identity" | "spaceIdentity"> {
  apiUrl: URL;
  identity: Identity;
  spaceIdentity?: Identity;
  // URL to hosted `worker/index.ts`
  workerUrl?: URL;
}

interface PendingRequest<T = unknown> {
  msgId: number;
  type: RuntimeClientMessageType;
  startTime: number;
  deferred: Deferred<T, Error>;
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * RuntimeClient provides a main-thread interface to a Runtime running in a web worker.
 *
 * This keeps heavy computation off the main thread while providing transparent
 * access to cells via CellHandle objects.
 *
 * Extends EventTarget to emit events for console messages, navigation requests,
 * and errors from recipes running in the worker.
 */
export class RuntimeClient extends EventTarget {
  private _worker: Worker;
  private _state: RuntimeClientState = RuntimeClientState.Uninitialized;
  private _pendingRequests = new Map<number, PendingRequest>();
  private _subscriptions = new Map<string, (value: unknown) => void>();
  private _nextMsgId = 0;
  private _timeoutMs: number;
  private _initializePromise: Promise<void>;
  private _initializeDeferred = defer<void>();
  private readonly _options: RuntimeClientOptions;
  constructor(options: RuntimeClientOptions) {
    super();
    this._timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const workerUrl = options.workerUrl ??
      (isDeno() ? new URL("worker/index.ts", import.meta.url) : undefined);
    if (!workerUrl) {
      throw new Error(
        "RuntimeClient `workerUrl` must be explicitly defined in non-Deno environments.",
      );
    }
    this._worker = new Worker(
      workerUrl,
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

    this._state = RuntimeClientState.Initializing;

    try {
      await this._sendRequest({
        type: RuntimeClientMessageType.Initialize,
        data: {
          apiUrl: this._options.apiUrl.toString(),
          identity: this._options.identity.serialize(),
          spaceIdentity: this._options.spaceIdentity?.serialize(),
          spaceDid: this._options.spaceDid,
          spaceName: this._options.spaceName,
        },
      });

      this._state = RuntimeClientState.Ready;
      this._initializeDeferred.resolve();
    } catch (error) {
      this._state = RuntimeClientState.Error;
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
        if (event.data?.type === RuntimeClientMessageType.Ready) {
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
    return this._state === RuntimeClientState.Ready;
  }

  /**
   * Get the current worker state
   */
  get state(): RuntimeClientState {
    return this._state;
  }

  getCellFromRef<T>(
    ref: CellRef,
  ): CellHandle<T> {
    return new CellHandle<T>(this, ref);
  }

  // unused?
  async getCell<T>(
    space: DID,
    cause: unknown,
    schema?: JSONSchema,
  ): Promise<CellHandle<T>> {
    await this.ready();

    const response = await this._sendRequest<GetCellResponse>({
      type: RuntimeClientMessageType.GetCell,
      space,
      cause,
      schema,
    });

    return new CellHandle<T>(this, response.cellRef);
  }

  /**
   * Wait for all pending operations to complete.
   */
  async idle(): Promise<void> {
    await this.ready();
    await this._sendRequest({ type: RuntimeClientMessageType.Idle });
  }

  // ============================================================================
  // Charm operations
  // ============================================================================

  /**
   * Create a new charm from a URL entry.
   * Returns a CellHandle for the charm's main cell.
   */
  async createCharmFromUrl<T>(
    entryUrl: URL,
    options?: { argument?: unknown; run?: boolean },
  ): Promise<{ cell: CellHandle<T>; result: CellHandle }> {
    await this.ready();

    const response = await this._sendRequest<CharmResultResponse>({
      type: RuntimeClientMessageType.CharmCreateFromUrl,
      entryUrl: entryUrl.href,
      argument: options?.argument,
      run: options?.run,
    });

    return {
      cell: new CellHandle<T>(this, response.charm.cellRef),
      result: new CellHandle(this, response.result),
    };
  }

  /**
   * Create a new charm from a Program.
   * Returns a CellHandle for the charm's main cell.
   */
  async createCharmFromProgram<T>(
    program: Program,
    options?: { argument?: unknown; run?: boolean },
  ): Promise<{ cell: CellHandle<T>; result: CellHandle } | null> {
    await this.ready();

    const response = await this._sendRequest<CharmResultResponse>({
      type: RuntimeClientMessageType.CharmCreateFromProgram,
      program,
      argument: options?.argument,
      run: options?.run,
    });

    return {
      cell: new CellHandle<T>(this, response.charm.cellRef),
      result: new CellHandle(this, response.result),
    };
  }

  async getSpaceRootPattern(): Promise<
    { cell: CellHandle<NameSchema>; result: CellHandle }
  > {
    const response = await this._sendRequest<CharmResultResponse>({
      type: RuntimeClientMessageType.GetSpaceRootPattern,
    });
    return {
      cell: new CellHandle<NameSchema>(this, response.charm.cellRef),
      result: new CellHandle(this, response.result),
    };
  }

  createCharmFromString<T>(
    source: string,
    options?: { argument?: unknown; run?: boolean },
  ): Promise<{ cell: CellHandle<T>; result: CellHandle } | null> {
    return this.createCharmFromProgram({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: source,
      }],
    }, options);
  }

  async runCharmSynced(
    charmId: string,
  ): Promise<{ cell: CellHandle; result: CellHandle } | null> {
    await this.ready();
    const response = await this._sendRequest<CharmResultResponse>({
      type: RuntimeClientMessageType.CharmSyncPattern,
      charmId,
    });
    if (!response.charm) return null;
    return {
      cell: new CellHandle(this, response.charm.cellRef),
      result: new CellHandle(this, response.result),
    };
  }

  /**
   * Get a charm by ID.
   * Returns null if the charm doesn't exist.
   */
  async getCharm<T>(
    charmId: string,
    runIt?: boolean,
  ): Promise<{ cell: CellHandle<T> } | null> {
    await this.ready();

    const response = await this._sendRequest<CharmGetResponse>({
      type: RuntimeClientMessageType.CharmGet,
      charmId,
      runIt,
    });

    if (!response.charm) return null;

    return {
      cell: new CellHandle<T>(this, response.charm.cellRef),
    };
  }

  /**
   * Remove a charm from the space.
   */
  async removeCharm(charmId: string): Promise<void> {
    await this.ready();
    await this._sendRequest({
      type: RuntimeClientMessageType.CharmRemove,
      charmId,
    });
  }

  /**
   * Start a charm's execution.
   */
  async startCharm(charmId: string): Promise<void> {
    await this.ready();
    await this._sendRequest({
      type: RuntimeClientMessageType.CharmStart,
      charmId,
    });
  }

  /**
   * Stop a charm's execution.
   */
  async stopCharm(charmId: string): Promise<void> {
    await this.ready();
    await this._sendRequest({
      type: RuntimeClientMessageType.CharmStop,
      charmId,
    });
  }

  /**
   * Get the charms list cell.
   * Subscribe to this cell to get reactive updates of all charms in the space.
   */
  async getCharmsListCell<T>(): Promise<CellHandle<T[]>> {
    await this.ready();

    const response = await this._sendRequest<CharmGetAllResponse>({
      type: RuntimeClientMessageType.CharmGetAll,
    });

    return new CellHandle<T[]>(this, response.charmsListCellRef);
  }

  /**
   * Wait for the CharmManager to be synced with storage.
   */
  async synced(): Promise<void> {
    await this.ready();
    await this._sendRequest({ type: RuntimeClientMessageType.CharmSynced });
  }

  /**
   * Dispose of the worker and clean up resources.
   */
  async dispose(): Promise<void> {
    if (
      this._state === RuntimeClientState.Terminating ||
      this._state === RuntimeClientState.Terminated
    ) {
      return;
    }

    this._state = RuntimeClientState.Terminating;

    // Reject all pending requests
    for (const pending of this._pendingRequests.values()) {
      clearTimeout(pending.timeoutId);
      pending.deferred.reject(new Error("RuntimeClient disposing"));
    }
    this._pendingRequests.clear();

    // Clear subscriptions
    this._subscriptions.clear();

    // Request graceful shutdown
    try {
      await this._sendRequest(
        { type: RuntimeClientMessageType.Dispose },
        5000, // Short timeout for dispose
      );
    } catch {
      // Ignore errors during dispose
    }

    // Terminate worker
    this._worker.terminate();
    this._state = RuntimeClientState.Terminated;
  }

  async [Symbol.asyncDispose]() {
    await this.dispose();
  }

  // ============================================================================
  // Internal methods used by CellHandle
  // ============================================================================

  /**
   * Send a request to the worker and return the response.
   * @internal
   */
  async sendRequest<R extends BaseResponse>(
    request: { type: RuntimeClientMessageType } & Record<string, unknown>,
  ): Promise<R> {
    await this.ready();
    return this._sendRequest<R>(request);
  }

  /**
   * Subscribe to cell updates from the worker.
   * @param hasValue Whether the client already has a cached value.
   *   If false, the worker will send the initial value immediately.
   */
  subscribe(
    cellRef: CellRef,
    callback: (value: unknown) => void,
    hasValue: boolean,
  ): SubscriptionId {
    const subscriptionId: SubscriptionId = globalThis.crypto.randomUUID();
    this._subscriptions.set(subscriptionId, callback);

    this._sendRequest({
      type: RuntimeClientMessageType.CellSubscribe,
      cellRef,
      subscriptionId,
      hasValue,
    }).catch((error) => {
      console.error("[RuntimeClient] Subscription failed:", error);
      this._subscriptions.delete(subscriptionId);
    });

    return subscriptionId;
  }

  /**
   * Unsubscribe from cell updates.
   */
  unsubscribe(subscriptionId: SubscriptionId): void {
    this._subscriptions.delete(subscriptionId);
    this._sendRequest({
      type: RuntimeClientMessageType.CellUnsubscribe,
      subscriptionId,
    }).catch((error) => {
      console.error("[RuntimeClient] Unsubscribe failed:", error);
    });
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private _sendRequest<R extends BaseResponse>(
    request: { type: RuntimeClientMessageType } & Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<R> {
    const timeout = timeoutMs ?? this._timeoutMs;
    const msgId = this._nextMsgId++;
    const message = { ...request, msgId };

    const deferred = defer<R, Error>();

    const timeoutId = setTimeout(() => {
      this._pendingRequests.delete(msgId);
      deferred.reject(
        new Error(`RuntimeClient request timed out: ${request.type}`),
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
    if (DEBUG_IPC) {
      console.log("[RuntimeClient->]", message);
    }
    this._worker.postMessage(message);

    return deferred.promise;
  }

  private _handleMessage = (event: MessageEvent): void => {
    const data = event.data;
    if (DEBUG_IPC) {
      console.log("[RuntimeClient<-]", data);
    }

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
          } satisfies RuntimeClientConsoleDetail,
        }),
      );
      return;
    }

    if (isNavigateRequestNotification(data)) {
      const target = new CellHandle(this, data.targetCellRef);
      this.dispatchEvent(
        new CustomEvent("navigate", {
          detail: {
            target,
          } satisfies RuntimeClientNavigateDetail,
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
          } satisfies RuntimeClientErrorDetail,
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
      console.warn("[RuntimeClient] Invalid response:", data);
      return;
    }

    const pending = this._pendingRequests.get(data.msgId);
    if (!pending) {
      console.warn(
        "[RuntimeClient] Response for unknown request:",
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
    console.error("[RuntimeClient] Worker error:", event);
    event.preventDefault();

    this._state = RuntimeClientState.Error;

    // Reject all pending requests
    for (const pending of this._pendingRequests.values()) {
      clearTimeout(pending.timeoutId);
      pending.deferred.reject(
        new Error(`RuntimeClient error: ${event.message}`),
      );
    }
    this._pendingRequests.clear();

    // Terminate worker
    this._worker.terminate();
  };
}
