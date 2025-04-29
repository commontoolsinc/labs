import { TaskPerform } from "./ipc.ts";
import { CommonIframeSandboxElement } from "./common-iframe-sandbox.ts";
import type { Cell } from "@commontools/runner";

export type { Cell };

// An `IframeContextHandler` is used by consumers to
// register how read/writing values from frames are handled.
export interface IframeContextHandler<Doc extends object = object> {
  read(element: CommonIframeSandboxElement, context: any, key: string): any;
  write(
    element: CommonIframeSandboxElement,
    context: Cell<Doc>,
    key: string,
    value: any,
  ): void;
  subscribe(
    element: CommonIframeSandboxElement,
    context: Cell<Doc>,
    key: string,
    callback: (key: string, value: any) => void,
    doNotSendMyDataBack: boolean,
  ): any;
  unsubscribe(
    element: CommonIframeSandboxElement,
    context: Cell<Doc>,
    receipt: any,
  ): void;
  onLLMRequest(
    element: CommonIframeSandboxElement,
    context: Cell<Doc>,
    payload: string,
  ): Promise<object>;
  onReadWebpageRequest(
    element: CommonIframeSandboxElement,
    context: Cell<Doc>,
    payload: string,
  ): Promise<object>;

  /**
   * Guest may send a command it wishes system to perform.
   */
  onPerform(
    element: CommonIframeSandboxElement,
    context: unknown,
    command: TaskPerform,
  ): Promise<{ ok: object; error?: void } | { ok?: void; error: Error }>;
}

let IframeHandler: IframeContextHandler | null = null;

// Set the `IframeContextHandler` singleton. Allows indirect cell synchronizing
// so that this sandboxing doesn't need to concern itself with application-level
// synchronizing mechanisms.
export function setIframeContextHandler(handler: IframeContextHandler) {
  IframeHandler = handler;
}

// Get the `IframeContextHandler` singleton.
export function getIframeContextHandler(): IframeContextHandler | null {
  return IframeHandler;
}
