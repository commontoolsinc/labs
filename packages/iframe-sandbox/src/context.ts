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
// TODO(danfuzz): every `unknown` below that stands for a cell's value -- the
// `read()` result, `write()`'s `value`, and the `callback` argument -- is a
// `FabricValue`, and typing it so is what would let this seam carry the whole
// domain, `codec-realm` being the mechanism. The values cross to the guest as
// themselves; see the markers on `HostMessage` and `GuestMessage` in
// `./ipc.ts` for what that costs.
export interface IframeContextHandler {
  read(
    element: CommonIframeSandboxElement,
    context: Context,
    key: string,
  ): unknown;
  write(
    element: CommonIframeSandboxElement,
    context: Context,
    key: string,
    value: unknown,
  ): void;
  subscribe(
    element: CommonIframeSandboxElement,
    context: Context,
    key: string,
    callback: (key: string, value: unknown) => void,
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
