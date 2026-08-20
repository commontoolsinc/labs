import type { FabricValue } from "@commonfabric/data-model/fabric-value";

import { CommonIframeSandboxElement } from "./common-iframe-sandbox.ts";

// This is typically an `Action` (possibly a new or old implementation),
// but type it as unknown, can handle in handler.
export type Receipt = unknown;
// This is typically a Cell, but can be anything passed into
// an element attribute.
export type Context = unknown;

// An `IframeContextHandler` is used by consumers to
// register how read/writing values from frames are handled.
//
// Each value below is a cell's value, so a `FabricValue`. The element encodes
// one on its way to the guest and decodes one on its way back; see
// `HostMessage` and `GuestMessage` in `./ipc.ts` for the form it crosses in.
export interface IframeContextHandler {
  read(
    element: CommonIframeSandboxElement,
    context: Context,
    key: string,
  ): FabricValue;
  write(
    element: CommonIframeSandboxElement,
    context: Context,
    key: string,
    value: FabricValue,
  ): void;
  subscribe(
    element: CommonIframeSandboxElement,
    context: Context,
    key: string,
    callback: (key: string, value: FabricValue) => void,
    doNotSendMyDataBack: boolean,
  ): Receipt;
  unsubscribe(
    element: CommonIframeSandboxElement,
    context: Context,
    receipt: Receipt,
  ): void;
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
