/**
 * RuntimeClient - Main thread controller for the worker-based Runtime
 *
 * This class manages a web worker that runs the Runtime, providing a clean API
 * for interacting with cells across the worker boundary.
 */

import type { DID, Identity } from "@commontools/identity";
import type { JSONSchema } from "@commontools/runner/shared";
import { Program } from "@commontools/js-compiler/interface";
import { CellHandle } from "./cell-handle.ts";
import {
  type CellRef,
  ConsoleNotification,
  ErrorNotification,
  InitializationData,
  JSONValue,
  NavigateRequestNotification,
  RequestType,
} from "./protocol/mod.ts";
import { NameSchema } from "@commontools/runner/schemas";
import { RuntimeTransport } from "./client/transport.ts";
import { EventEmitter } from "./client/emitter.ts";
import {
  InitializedRuntimeConnection,
  RuntimeConnection,
} from "./client/connection.ts";
import { PageHandle } from "./page-handle.ts";

export interface RuntimeClientOptions
  extends Omit<InitializationData, "apiUrl" | "identity" | "spaceIdentity"> {
  apiUrl: URL;
  identity: Identity;
  spaceIdentity?: Identity;
}

export type RuntimeClientEvents = {
  console: [ConsoleNotification];
  navigaterequest: [{ cell: CellHandle }];
  error: [ErrorNotification];
};

export const $conn = Symbol("$request");

/**
 * RuntimeClient provides a main-thread interface to a Runtime running elsewhere.
 */
export class RuntimeClient extends EventEmitter<RuntimeClientEvents> {
  #conn: InitializedRuntimeConnection;

  private constructor(
    conn: InitializedRuntimeConnection,
    _options: RuntimeClientOptions,
  ) {
    super();
    this.#conn = conn;
    this.#conn.on("console", this._onConsole);
    this.#conn.on("navigaterequest", this._onNavigateRequest);
    this.#conn.on("error", this._onError);
  }

  static async initialize(
    transport: RuntimeTransport,
    options: RuntimeClientOptions,
  ): Promise<RuntimeClient> {
    const initialized = await (new RuntimeConnection(transport)).initialize({
      apiUrl: options.apiUrl.toString(),
      identity: options.identity.serialize(),
      spaceIdentity: options.spaceIdentity?.serialize(),
      spaceDid: options.spaceDid,
      spaceName: options.spaceName,
    });
    return new RuntimeClient(initialized, options);
  }

  getCellFromRef<T>(
    ref: CellRef,
  ): CellHandle<T> {
    return new CellHandle<T>(this, ref);
  }

  // TODO(unused)
  // Currently unused in shell, but a CharmManager-like layer
  // could be built using this
  async getCell<T>(
    space: DID,
    cause: JSONValue,
    schema?: JSONSchema,
  ): Promise<CellHandle<T>> {
    const response = await this.#conn.request<RequestType.GetCell>({
      type: RequestType.GetCell,
      space,
      cause,
      schema,
    });

    return new CellHandle<T>(this, response.cell);
  }

  // TODO(unused)
  async idle(): Promise<void> {
    await this.#conn.request<RequestType.Idle>({ type: RequestType.Idle });
  }

  async createPage<T = unknown, R = unknown>(
    input: string | URL | Program,
    options?: { argument?: JSONValue; run?: boolean },
  ): Promise<PageHandle<T, R>> {
    const source = input instanceof URL
      ? { url: input.href }
      : typeof input === "string"
      ? {
        program: {
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: input,
          }],
        },
      }
      : { program: input };

    const response = await this.#conn.request<
      RequestType.PageCreate
    >({
      type: RequestType.PageCreate,
      source,
      argument: options?.argument,
      run: options?.run,
    });

    return new PageHandle<T, R>(this, response.page);
  }

  async getSpaceRootPattern(): Promise<PageHandle<NameSchema>> {
    const response = await this.#conn.request<
      RequestType.GetSpaceRootPattern
    >({
      type: RequestType.GetSpaceRootPattern,
    });
    return new PageHandle<NameSchema>(this, response.page);
  }

  async getPage<T = unknown, R = unknown>(
    pageId: string,
    runIt?: boolean,
  ): Promise<PageHandle<T, R> | null> {
    const response = await this.#conn.request<RequestType.PageGet>({
      type: RequestType.PageGet,
      pageId: pageId,
      runIt,
    });

    if (!response) return null;

    return new PageHandle<T, R>(this, response.page);
  }

  async removePage(pageId: string): Promise<boolean> {
    const res = await this.#conn.request<RequestType.PageRemove>({
      type: RequestType.PageRemove,
      pageId: pageId,
    });
    return res.value;
  }

  /**
   * Get the charms list cell.
   * Subscribe to this cell to get reactive updates of all charms in the space.
   */
  async getCharmsListCell<T>(): Promise<CellHandle<T[]>> {
    const response = await this.#conn.request<RequestType.PageGetAll>({
      type: RequestType.PageGetAll,
    });

    return new CellHandle<T[]>(this, response.cell);
  }

  /**
   * Wait for the CharmManager to be synced with storage.
   */
  async synced(): Promise<void> {
    await this.#conn.request<RequestType.PageSynced>({
      type: RequestType.PageSynced,
    });
  }

  async dispose(): Promise<void> {
    await this.#conn.dispose();
  }

  async [Symbol.asyncDispose]() {
    await this.dispose();
  }

  [$conn](): InitializedRuntimeConnection {
    return this.#conn;
  }

  private _onConsole = (data: ConsoleNotification): void => {
    this.emit("console", data);
  };

  private _onNavigateRequest = (data: NavigateRequestNotification): void => {
    this.emit("navigaterequest", {
      cell: new CellHandle(this, data.targetCellRef),
    });
  };

  private _onError = (data: ErrorNotification): void => {
    this.emit("error", data);
  };
}
