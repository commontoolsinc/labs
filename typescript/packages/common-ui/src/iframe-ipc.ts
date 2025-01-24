// Types used by the `common-iframe` IPC.

export interface IframeContextHandler {
  read(context: any, key: string): any,
  write(context: any, key: string, value: any): void,
  subscribe(context: any, key: string, callback: (key: string, value: any) => void): any,
  unsubscribe(context: any, receipt: any): void,
}

let IframeHandler: IframeContextHandler = null;
// Set the `IframeContextHandler` singleton. Allows cell synchronizing
// so that `common-ui` doesn't directly depend on `common-runner`.
export function setIframeContextHandler(handler: IframeContextHandler) {
  IframeHandler = handler;
}

// Get the `IframeContextHandler` singleton.
export function getIframeContextHandler(): IframeContextHandler | null {
  return IframeHandler;
}

export interface GuestError {
  description: string;
  source: string;
  lineno: number;
  colno: number;
  stacktrace: string;
}

export function isGuestError(e: object): e is GuestError {
  return typeof e === "object" &&
    e !== null &&
    "description" in e && typeof e.description === "string" &&
    "source" in e && typeof e.source === "string" &&
    "lineno" in e && typeof e.lineno === "number" &&
    "colno" in e && typeof e.colno === "number" &&
    "stacktrace" in e && typeof e.stacktrace === "string"
}

export enum HostMessageType {
  Update = "update",
}

export type HostMessage =
  | { type: HostMessageType.Update, data: [string, any] };

export enum GuestMessageType {
  Error = "error",
  Subscribe = "subscribe",
  Unsubscribe = "unsubscribe",
  Write = "write",
  Read = "read",
}

export type GuestMessage =
  | { type: GuestMessageType.Error, data: GuestError }
  | { type: GuestMessageType.Subscribe, data: string }
  | { type: GuestMessageType.Unsubscribe, data: string }
  | { type: GuestMessageType.Read, data: string }
  | { type: GuestMessageType.Write, data: [string, any] };

export function isGuestMessage(message: any): message is GuestMessage {
  if (typeof message !== "object" ||
    !("type" in message) ||
    typeof message.type !== "string" ||
    !("data" in message) ||
    message.data == null) {
    return false;
  }
  switch (message.type) {
    case GuestMessageType.Error: {
      return isGuestError(message.data);
    }
    case GuestMessageType.Subscribe:
    case GuestMessageType.Read:
    case GuestMessageType.Unsubscribe: {
      return typeof message.data === "string"
    }
    case GuestMessageType.Write: {
      return Array.isArray(message.data) &&
        message.data.length === 2 &&
        typeof message.data[0] === "string" &&
        message.data[1] != null
    }
  }
  return false;
}
