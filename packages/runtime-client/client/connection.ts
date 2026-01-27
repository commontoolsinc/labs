import { defer, type Deferred } from "@commontools/utils/defer";
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
  NavigateRequestNotification,
  RequestType,
  TelemetryNotification,
} from "../protocol/mod.ts";
import { RuntimeTransport } from "./transport.ts";
import { EventEmitter } from "./emitter.ts";
import { $onCellUpdate, CellHandle } from "../cell-handle.ts";
import { cellRefToKey } from "../shared/utils.ts";

const DEBUG_IPC = false;
const DEFAULT_TIMEOUT_MS = 60_000;

interface PendingRequest<T = unknown> {
  msgId: number;
  type: RequestType;
  startTime: number;
  deferred: Deferred<T, Error>;
  timeoutId: ReturnType<typeof setTimeout>;
}

export type RuntimeConnectionEvents = {
  console: [ConsoleNotification];
  navigaterequest: [NavigateRequestNotification];
  error: [ErrorNotification];
  telemetry: [TelemetryNotification];
};

export interface InitializedRuntimeConnection extends RuntimeConnection {}

export class RuntimeConnection extends EventEmitter<RuntimeConnectionEvents> {
  #pendingRequests = new Map<number, PendingRequest>();
  #nextMsgId = 0;
  #timeoutMs = DEFAULT_TIMEOUT_MS;
  #initialized = false;
  #transport: RuntimeTransport;
  #subscribed = new Map<
    `${string}:${string}:${string}`,
    Set<CellHandle>
  >();

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
        instances.add(cell);
        // Copy the cached value from an existing subscriber to the new one
        // This ensures late subscribers get the initial value
        const existingInstance = instances.values().next().value;
        if (existingInstance) {
          const cachedValue = existingInstance.get();
          if (cachedValue !== undefined) {
            cell[$onCellUpdate](cachedValue);
          }
        }
      }
      return;
    }
    instances = new Set([cell]);
    this.#subscribed.set(key, instances);
    const _ = await this.request<RequestType.CellSubscribe>({
      type: RequestType.CellSubscribe,
      cell: cell.ref(),
    }).catch((error) => {
      console.error("[RuntimeClient] Subscription failed:", error);
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
    instances.delete(cell);
    if (instances.size > 0) {
      return;
    }
    this.#subscribed.delete(key);
    const _ = await this.request<RequestType.CellUnsubscribe>({
      type: RequestType.CellUnsubscribe,
      cell: cell.ref(),
    }).catch((error) => {
      console.error("[RuntimeClient] Unsubscription failed:", error);
    });
    return;
  }

  async dispose(): Promise<void> {
    for (const pending of this.#pendingRequests.values()) {
      clearTimeout(pending.timeoutId);
      pending.deferred.reject(new Error("Disposing runtime connection"));
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

    const subscribed = this.#subscribed.get(cellRefToKey(cellRef));
    if (subscribed && subscribed.size > 0) {
      for (const instance of subscribed) {
        instance[$onCellUpdate](value);
      }
    }
  }
}
