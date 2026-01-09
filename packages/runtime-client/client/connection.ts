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
  NavigateRequestNotification,
  RequestType,
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
      console.log("[RuntimeClient->]", message);
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
    if (DEBUG_IPC) {
      console.log("[RuntimeClient<-]", message);
    }

    if (isIPCRemoteNotification(message)) {
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
      pending.deferred.reject(new Error(message.error));
    } else {
      pending.deferred.resolve("data" in message ? message.data : undefined);
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
