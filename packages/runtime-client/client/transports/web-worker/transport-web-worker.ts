import { defer } from "@commontools/utils/defer";
import { isDeno } from "@commontools/utils/env";
import {
  ErrorNotification,
  IPCClientMessage,
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

  send(data: IPCClientMessage): void {
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

    if (!this._ready && data === "READY") {
      this._ready = true;
      this._readyPromise.resolve();
      return;
    }

    this.emit("message", event.data);
  };

  private _handleError = (event: ErrorEvent): void => {
    event.preventDefault();

    this.emit("message", {
      type: NotificationType.ErrorReport,
      message: `${event.error}`,
      stackTrace: event.error?.stack,
    } as ErrorNotification);
  };
}
