// An `IframeContextHandler` is used by consumers to
// register how read/writing values from frames are handled.
export interface IframeContextHandler {
  read(context: any, key: string): any;
  write(context: any, key: string, value: any): void;
  subscribe(
    context: any,
    key: string,
    callback: (key: string, value: any) => void,
    doNotSendMyDataBack: boolean,
  ): any;
  unsubscribe(context: any, receipt: any): void;
  onLLMRequest(context: any, payload: string): Promise<object>;
  onReadWebpageRequest(context: any, payload: string): Promise<object>;
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
