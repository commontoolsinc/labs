import { defer, type Deferred } from "@commonfabric/utils/defer";
import { getLogger } from "@commonfabric/utils/logger";
import {
  CellUpdateNotification,
  CommandRequest,
  CommandResponse,
  Commands,
  ConsoleNotification,
  ErrorNotification,
  InitializationData,
  IPCRemoteMessage,
  isCellUpdateNotification,
  isConsoleNotification,
  isErrorNotification,
  isIPCRemoteNotification,
  isIPCRemoteResponse,
  isNavigateRequestNotification,
  isTelemetryNotification,
  isVDomBatchNotification,
  NavigateRequestNotification,
  RequestType,
  TelemetryNotification,
  VDomBatchNotification,
} from "../protocol/mod.ts";
import { RuntimeTransport } from "./transport.ts";
import { EventEmitter } from "./emitter.ts";
import { $onCellUpdate, CellHandle } from "../cell-handle.ts";
import { cellRefToKey } from "../shared/utils.ts";
import {
  isRuntimeDisposedError,
  RuntimeDisposedError,
} from "../shared/disposed-error.ts";

const ipcLogger = getLogger("runtime-client");

const DEBUG_IPC = false;
const DEFAULT_TIMEOUT_MS = 60_000;

interface PendingRequest<T = unknown> {
  msgId: number;
  type: RequestType;
  startTime: number;
  deferred: Deferred<T, Error>;
  timeoutId: ReturnType<typeof setTimeout>;
}

type SubscriptionCounterName =
  | "localSubscribes"
  | "localUnsubscribes"
  | "backendSubscribes"
  | "backendUnsubscribes";

type SubscriptionCounterTotals = Record<SubscriptionCounterName, number>;

export type CellSubscriptionDiagnostics = SubscriptionCounterTotals & {
  key: string;
  activeInstances: number;
};

export type SubscriptionDiagnostics = {
  totals: SubscriptionCounterTotals & { activeInstances: number };
  cells: Record<string, CellSubscriptionDiagnostics>;
};

export type RuntimeConnectionEvents = {
  console: [ConsoleNotification];
  navigaterequest: [NavigateRequestNotification];
  error: [ErrorNotification];
  telemetry: [TelemetryNotification];
  vdombatch: [VDomBatchNotification];
};

export interface InitializedRuntimeConnection extends RuntimeConnection {}

export class RuntimeConnection extends EventEmitter<RuntimeConnectionEvents> {
  #pendingRequests = new Map<number, PendingRequest>();
  #nextMsgId = 0;
  #timeoutMs = DEFAULT_TIMEOUT_MS;
  #initialized = false;
  #disposed = false;
  #transport: RuntimeTransport;
  #subscribed = new Map<string, Set<CellHandle>>();
  #subscriptionDiagnostics = new Map<string, SubscriptionCounterTotals>();

  constructor(transport: RuntimeTransport) {
    super();
    this.#transport = transport;
    this.#transport.on("message", this._handleMessage);
  }

  async initialize(
    data: InitializationData,
  ): Promise<InitializedRuntimeConnection> {
    await this.request<RequestType.Initialize>({
      type: RequestType.Initialize,
      data,
    });
    this.#initialized = true;
    return this as InitializedRuntimeConnection;
  }

  request<
    T extends keyof Commands,
  >(
    data: CommandRequest<T>,
    timeoutMs?: number,
  ): Promise<CommandResponse<T>> {
    if (!this.#initialized && data.type !== RequestType.Initialize) {
      throw new Error("RuntimeConnection is uninitialized.");
    }
    if (this.#disposed && data.type !== RequestType.Dispose) {
      // Reject instead of sending into a (soon-to-be) dead transport,
      // where the request would only ever time out.
      return Promise.reject(
        new RuntimeDisposedError(
          `RuntimeConnection is disposed (request: ${data.type})`,
        ),
      );
    }
    const timeout = timeoutMs ?? this.#timeoutMs;
    const msgId = this.#nextMsgId++;
    const message = { msgId, data };

    const deferred = defer<CommandResponse<T>, Error>();

    const timeoutId = setTimeout(() => {
      this.#pendingRequests.delete(msgId);
      deferred.reject(
        new Error(`RuntimeClient request timed out: ${data.type}`),
      );
    }, timeout);

    const pending: PendingRequest<CommandResponse<T>> = {
      msgId,
      type: data.type,
      startTime: performance.now(),
      deferred,
      timeoutId,
    };

    this.#pendingRequests.set(msgId, pending as PendingRequest);
    if (DEBUG_IPC) {
      console.log(
        `[IPC(\x1B[1m${message.msgId}\x1B[0m)\x1B[96m=>\x1B[0m]`,
        message.data,
      );
    }
    this.#transport.send(message);

    return deferred.promise;
  }

  async subscribe(
    cell: CellHandle<any>,
  ): Promise<void> {
    const key = cellRefToKey(cell.ref());
    let instances = this.#subscribed.get(key);
    if (instances) {
      if (!instances.has(cell)) {
        this.#recordSubscriptionDiagnostic(key, "localSubscribes");
        instances.add(cell);
        // Copy the cached value (and label) from an existing subscriber to the
        // new one so late subscribers get the initial value.
        const existingInstance = instances.values().next().value;
        if (existingInstance) {
          const cachedValue = existingInstance.get();
          if (cachedValue !== undefined) {
            cell[$onCellUpdate](cachedValue, {
              cfcLabel: existingInstance.cfcLabel,
            });
          }
        }
      }
      return;
    }
    this.#recordSubscriptionDiagnostic(key, "localSubscribes");
    instances = new Set([cell]);
    this.#subscribed.set(key, instances);
    this.#recordSubscriptionDiagnostic(key, "backendSubscribes");
    const _ = await this.request<RequestType.CellSubscribe>({
      type: RequestType.CellSubscribe,
      cell: cell.ref(),
      // First subscriber to a ref key decides label delivery for that backend
      // subscription (the worker dedups by ref key too). Label-displaying
      // callers create dedicated handles, so they are that first subscriber.
      ...(cell.wantsCfcLabel ? { includeCfcLabel: true } : {}),
    }).catch((error) => {
      if (!isRuntimeDisposedError(error)) {
        console.error("[RuntimeClient] Subscription failed:", error);
      }
      this.#subscribed.delete(key);
    });
    return;
  }

  async unsubscribe(
    cell: CellHandle<any>,
  ): Promise<void> {
    const key = cellRefToKey(cell.ref());
    const instances = this.#subscribed.get(key);
    if (!instances || !instances.has(cell)) {
      return;
    }
    this.#recordSubscriptionDiagnostic(key, "localUnsubscribes");
    instances.delete(cell);
    if (instances.size > 0) {
      return;
    }
    this.#subscribed.delete(key);
    if (this.#disposed) return;
    this.#recordSubscriptionDiagnostic(key, "backendUnsubscribes");
    const _ = await this.request<RequestType.CellUnsubscribe>({
      type: RequestType.CellUnsubscribe,
      cell: cell.ref(),
    }).catch((error) => {
      if (!isRuntimeDisposedError(error)) {
        console.error("[RuntimeClient] Unsubscription failed:", error);
      }
    });
    return;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const pending of this.#pendingRequests.values()) {
      clearTimeout(pending.timeoutId);
      pending.deferred.reject(
        new RuntimeDisposedError("Disposing runtime connection"),
      );
    }
    this.#pendingRequests.clear();

    await this.request<RequestType.Dispose>(
      { type: RequestType.Dispose },
      5000, // Short timeout for dispose
    );
    await this.#transport.dispose();
  }

  async [Symbol.asyncDispose]() {
    await this.dispose();
  }

  getSubscriptionDiagnostics(): SubscriptionDiagnostics {
    const keys = new Set<string>([
      ...this.#subscriptionDiagnostics.keys(),
      ...this.#subscribed.keys(),
    ]);
    const totals: SubscriptionDiagnostics["totals"] = {
      localSubscribes: 0,
      localUnsubscribes: 0,
      backendSubscribes: 0,
      backendUnsubscribes: 0,
      activeInstances: 0,
    };
    const cells: Record<string, CellSubscriptionDiagnostics> = {};

    for (const key of [...keys].sort()) {
      const counts = this.#subscriptionDiagnostics.get(key) ??
        this.#emptySubscriptionCounters();
      const activeInstances = this.#subscribed.get(key)?.size ?? 0;
      const entry: CellSubscriptionDiagnostics = {
        key,
        ...counts,
        activeInstances,
      };
      cells[key] = entry;
      totals.localSubscribes += entry.localSubscribes;
      totals.localUnsubscribes += entry.localUnsubscribes;
      totals.backendSubscribes += entry.backendSubscribes;
      totals.backendUnsubscribes += entry.backendUnsubscribes;
      totals.activeInstances += entry.activeInstances;
    }

    return { totals, cells };
  }

  resetSubscriptionDiagnostics(): void {
    this.#subscriptionDiagnostics.clear();
  }

  private _handleMessage = (message: IPCRemoteMessage): void => {
    if (isIPCRemoteNotification(message)) {
      if (isTelemetryNotification(message)) {
        this.emit("telemetry", message);
        // Do not log telemetry events when DEBUG_IPC is enabled
        return;
      }
      if (DEBUG_IPC) {
        console.log(`[IPC\x1B[92m<=\x1B[0m]`, message);
      }
      if (isCellUpdateNotification(message)) {
        this._handleCellUpdate(message);
      } else if (isConsoleNotification(message)) {
        this.emit("console", message);
      } else if (isNavigateRequestNotification(message)) {
        this.emit("navigaterequest", message);
      } else if (isErrorNotification(message)) {
        this.emit("error", message);
      } else if (isVDomBatchNotification(message)) {
        this.emit("vdombatch", message);
      } else {
        console.warn(`Unknown notification: ${JSON.stringify(message)}`);
      }
      return;
    }

    if (!isIPCRemoteResponse(message)) {
      console.warn("[RuntimeClient] Invalid response:", message);
      return;
    }
    const { msgId } = message;
    const pending = this.#pendingRequests.get(msgId);
    if (!pending) {
      console.warn(
        `[RuntimeClient] Response for unknown request: ${msgId}`,
      );
      return;
    }

    clearTimeout(pending.timeoutId);
    this.#pendingRequests.delete(msgId);

    // Record IPC round-trip time using hierarchical keys
    ipcLogger.time(pending.startTime, "ipc", pending.type);

    if ("error" in message && message.error) {
      if (DEBUG_IPC) {
        console.log(
          `[IPC(\x1B[1m${msgId}\x1B[0m)\x1B[91m<=\x1B[0m]`,
          message.error,
        );
      }
      pending.deferred.reject(new Error(message.error));
    } else {
      const data = "data" in message ? message.data : undefined;
      if (DEBUG_IPC) {
        console.log(
          `[IPC(\x1B[1m${msgId}\x1B[0m)\x1B[92m<=\x1B[0m]`,
          data,
        );
      }
      pending.deferred.resolve(data);
    }
  };

  private _handleCellUpdate(message: CellUpdateNotification): void {
    const { cell: cellRef, value } = message;
    if (value === undefined) {
      // A value can be reported as `undefined` only when there's been a
      // conflict, and will be followed by the settled value. Ignore
      // `undefined` callbacks here.
      return;
    }

    // Field presence (not value) signals a label-aware notification, so a
    // label of `undefined` is still delivered and a value-only update never
    // touches the cached label.
    const labelUpdate = "cfcLabel" in message
      ? { cfcLabel: message.cfcLabel }
      : undefined;

    const subscribed = this.#subscribed.get(cellRefToKey(cellRef));
    if (subscribed && subscribed.size > 0) {
      for (const instance of subscribed) {
        instance[$onCellUpdate](value, labelUpdate);
      }
    }
  }

  #recordSubscriptionDiagnostic(
    key: string,
    counter: SubscriptionCounterName,
  ): void {
    const counts = this.#subscriptionDiagnostics.get(key) ??
      this.#emptySubscriptionCounters();
    counts[counter]++;
    this.#subscriptionDiagnostics.set(key, counts);
  }

  #emptySubscriptionCounters(): SubscriptionCounterTotals {
    return {
      localSubscribes: 0,
      localUnsubscribes: 0,
      backendSubscribes: 0,
      backendUnsubscribes: 0,
    };
  }

  /**
   * Send a DOM event to the worker for dispatch to the appropriate handler.
   * This is a fire-and-forget operation - we don't wait for a response.
   */
  sendVDomEvent(
    mountId: number,
    handlerId: number,
    event: import("../protocol/mod.ts").SerializedDomEvent,
    nodeId: number,
  ): void {
    if (this.#disposed) return;
    // Use request but don't await - fire and forget
    this.request<RequestType.VDomEvent>({
      type: RequestType.VDomEvent,
      mountId,
      handlerId,
      event,
      nodeId,
    }).catch((error) => {
      if (!isRuntimeDisposedError(error)) {
        console.error(
          "[RuntimeClient] VDom event dispatch failed:",
          error instanceof Error ? error.message : String(error),
          error,
        );
      }
    });
  }

  /**
   * Notify the worker that a VDOM batch has been applied on the main thread.
   */
  ackVDomBatch(mountId: number, batchId: number): void {
    if (this.#disposed) return;
    this.request<RequestType.VDomBatchApplied>({
      type: RequestType.VDomBatchApplied,
      mountId,
      batchId,
    }).catch((error) => {
      if (!isRuntimeDisposedError(error)) {
        console.error(
          "[RuntimeClient] VDom batch acknowledgement failed:",
          error instanceof Error ? error.message : String(error),
          error,
        );
      }
    });
  }

  /**
   * Request the worker to start VDOM rendering for a cell.
   */
  async mountVDom(
    mountId: number,
    cellRef: import("../protocol/mod.ts").CellRef,
  ): Promise<import("../protocol/mod.ts").VDomMountResponse> {
    const response = await this.request<RequestType.VDomMount>({
      type: RequestType.VDomMount,
      mountId,
      cell: cellRef,
    });
    return response!;
  }

  /**
   * Request the worker to stop VDOM rendering for a mount.
   */
  async unmountVDom(mountId: number): Promise<void> {
    if (this.#disposed) return;
    await this.request<RequestType.VDomUnmount>({
      type: RequestType.VDomUnmount,
      mountId,
    });
  }
}
