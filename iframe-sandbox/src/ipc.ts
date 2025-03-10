// Types used by the `common-iframe-sandbox` IPC.

// Diagram of the IPC messages between the Host
// environment, and the intermediary guest iframe.
//
// ┌──────────────┐              ┌───────────────┐
// │     Host     │              │     Guest     │
// └───────┬──────┘              └───────┬───────┘
//         │                             │
//         │◄───────────READY────────────┤
//         │                             │
//         ├────────────INIT────────────►│
//    ┌───►│                             │
//    │    ├────────LOAD-DOCUMENT───────►│
//    │    │                             │
//    │    │◄───────────LOAD─────────────┤
//    │    │                             │◄───┐
//    │    │◄────────PASSTHROUGH────────►│    │
//    │    ▼                             ▼    │
//    └────┘                             └────┘

export enum IPCHostMessageType {
  // Host initializing guest with data (namely, ID).
  Init = "init",
  // Host instructing guest to load a new document.
  LoadDocument = "load-document",
  // Host instructing guest to pass through a `HostMessage`.
  Passthrough = "passthrough",
}

export type IPCHostMessage =
  | { id: any; type: IPCHostMessageType.Init }
  | { id: any; type: IPCHostMessageType.LoadDocument; data: string }
  | { id: any; type: IPCHostMessageType.Passthrough; data: HostMessage };

export enum IPCGuestMessageType {
  // Guest alerting the host that it is ready.
  Ready = "ready",
  // An error occurred in the outer frame.
  Error = "error",
  // Guest inner frame has loaded.
  Load = "load",
  // Guest passing a `GuestMessage`.
  Passthrough = "passthrough",
}

export type IPCGuestMessage =
  | { type: IPCGuestMessageType.Ready }
  | { id: any; type: IPCGuestMessageType.Load }
  | { id: any; type: IPCGuestMessageType.Error; data: any }
  | { id: any; type: IPCGuestMessageType.Passthrough; data: GuestMessage };

export function isIPCGuestMessage(message: any): message is IPCGuestMessage {
  if (typeof message !== "object" || !("type" in message)) {
    return false;
  }
  switch (message.type) {
    case IPCGuestMessageType.Ready: {
      return true;
    }
    case IPCGuestMessageType.Error:
    case IPCGuestMessageType.Passthrough:
    case IPCGuestMessageType.Load: {
      if (
        message.type !== IPCGuestMessageType.Load &&
        (!("data" in message) || message.data == null)
      ) {
        return false;
      }
      if (
        message.type === IPCGuestMessageType.Passthrough &&
        !isGuestMessage(message.data)
      ) {
        return false;
      }
      return ("id" in message) && message.id != null;
    }
  }
  return false;
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
    "stacktrace" in e && typeof e.stacktrace === "string";
}

export enum HostMessageType {
  Update = "update",
  LLMResponse = "llm-response",
}

export type HostMessage =
  | { type: HostMessageType.Update; data: [string, any] }
  | {
    type: HostMessageType.LLMResponse;
    request: string;
    data: object | null;
    error: any;
  };

export enum GuestMessageType {
  Error = "error",
  Subscribe = "subscribe",
  Unsubscribe = "unsubscribe",
  Write = "write",
  Read = "read",
  LLMRequest = "llm-request",
}

export type GuestMessage =
  | { type: GuestMessageType.Error; data: GuestError }
  | { type: GuestMessageType.Subscribe; data: string }
  | { type: GuestMessageType.Unsubscribe; data: string }
  | { type: GuestMessageType.Read; data: string }
  | { type: GuestMessageType.Write; data: [string, any] }
  | { type: GuestMessageType.LLMRequest; data: string };

export function isGuestMessage(message: any): message is GuestMessage {
  if (
    typeof message !== "object" ||
    !("type" in message) ||
    typeof message.type !== "string" ||
    !("data" in message) ||
    message.data == null
  ) {
    return false;
  }
  switch (message.type) {
    case GuestMessageType.Error: {
      return isGuestError(message.data);
    }
    case GuestMessageType.LLMRequest:
    case GuestMessageType.Subscribe:
    case GuestMessageType.Read:
    case GuestMessageType.Unsubscribe: {
      return typeof message.data === "string";
    }
    case GuestMessageType.Write: {
      return Array.isArray(message.data) &&
        message.data.length === 2 &&
        typeof message.data[0] === "string" &&
        message.data[1] != null;
    }
  }
  return false;
}
