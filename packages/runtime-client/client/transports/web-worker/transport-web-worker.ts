import { defer } from "@commonfabric/utils/defer";
import { isDeno } from "@commonfabric/utils/env";
import {
  ErrorNotification,
  IPCClientMessage,
  IPCClientNotification,
  isWorkerConsoleNotification,
  isWorkerReadyNotification,
  NotificationType,
} from "../../../protocol/mod.ts";
import { RuntimeTransport, RuntimeTransportEvents } from "../../transport.ts";
import { EventEmitter } from "../../emitter.ts";

export interface WebWorkerRuntimeTransportOptions {
  // URL to hosted `backends/web-worker/index.ts`
  workerUrl?: URL;
}

export class WebWorkerRuntimeTransport
  extends EventEmitter<RuntimeTransportEvents>
  implements RuntimeTransport {
  private _ready = false;
  private _readyPromise = defer<void>();
  private _worker: Worker;
  constructor(options: WebWorkerRuntimeTransportOptions = {}) {
    super();
    const workerUrl = options.workerUrl ??
      (isDeno()
        ? new URL("../../../backends/web-worker/index.ts", import.meta.url)
        : undefined);
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
    this._worker.addEventListener("message", this._handleMessage);
    this._worker.addEventListener("error", this._handleError);
  }

  send(data: IPCClientMessage | IPCClientNotification): void {
    // TODO(danfuzz): this send should encode `data` with `codec-realm`, which
    // is what would let the payload carry the whole `FabricValue` domain
    // instead of whatever structured cloning happens to preserve of it. The
    // payload type carries the matching marker -- `IPCClientRequest` in
    // `../../../protocol/types.ts` -- as does the receiving end, the `message`
    // listener in `../../../backends/web-worker/index.ts`.
    this._worker.postMessage(data);
  }

  dispose(): Promise<void> {
    this.removeAllListeners();
    this._worker.terminate();
    return Promise.resolve();
  }

  async [Symbol.asyncDispose]() {
    await this.dispose();
  }

  ready(): Promise<void> {
    return this._readyPromise.promise;
  }

  static connect(
    options: WebWorkerRuntimeTransportOptions = {},
  ): Promise<WebWorkerRuntimeTransport> {
    const transport = new WebWorkerRuntimeTransport(options);
    return transport.ready().then(() => transport);
  }

  private _handleMessage = (event: MessageEvent): void => {
    const data = event.data;

    // Worker-side console output forwarded by the bridge in
    // `backends/web-worker/index.ts` (opt-in). Re-emit it on the page
    // console so it reaches devtools and integration-test console capture,
    // then stop: it is this transport's traffic, not the connection's.
    if (isWorkerConsoleNotification(data)) {
      console[data.level](`[worker] ${data.text}`);
      return;
    }

    if (!this._ready && isWorkerReadyNotification(data)) {
      this._ready = true;
      this._readyPromise.resolve();
      return;
    }

    this.emit("message", data);
  };

  private _handleError = (event: ErrorEvent): void => {
    event.preventDefault();

    const error = new Error(
      typeof event.error?.message === "string"
        ? event.error.message
        : event.message || "Web worker failed before initialization",
    );
    if (typeof event.error?.name === "string") {
      error.name = event.error.name;
    }
    if (typeof event.error?.stack === "string") {
      error.stack = event.error.stack;
    }

    if (!this._ready) {
      this._readyPromise.reject(error);
      return;
    }

    this.emit("message", {
      type: NotificationType.ErrorReport,
      message: `${error}`,
      stackTrace: error.stack,
    } as ErrorNotification);
  };
}
