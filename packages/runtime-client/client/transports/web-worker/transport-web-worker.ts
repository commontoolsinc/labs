import { defer } from "@commonfabric/utils/defer";
import { isDeno } from "@commonfabric/utils/env";
import {
  ErrorNotification,
  IPCClientMessage,
  IPCClientNotification,
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
    // then stop: it is not an IPC response and carries no `msgId`.
    if (
      data && typeof data === "object" &&
      (data as { __workerConsole?: unknown }).__workerConsole
    ) {
      const { level, text } = (data as {
        __workerConsole: { level: string; text: string };
      }).__workerConsole;
      const sink = (console as unknown as Record<
        string,
        (message: string) => void
      >)[level] ?? console.log;
      sink(`[worker] ${text}`);
      return;
    }

    if (!this._ready && data === "READY") {
      this._ready = true;
      this._readyPromise.resolve();
      return;
    }

    this.emit("message", event.data);
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
