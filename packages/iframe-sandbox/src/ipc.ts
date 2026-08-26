// Types used by the `common-iframe-sandbox` IPC.

import type { FabricValue } from "@commonfabric/data-model/fabric-value";

// Diagram of the messages between the Host environment, the intermediary outer
// frame, and the guest in the inner frame.
//
// ┌──────────────┐        ┌───────────────┐        ┌───────────────┐
// │     Host     │        │  Outer frame  │        │     Guest     │
// └───────┬──────┘        └───────┬───────┘        └───────┬───────┘
//         │                       │                        │
//         │◄────────READY─────────┤                        │
//         │                       │                        │
//         ├─────LOAD-DOCUMENT────►│                        │
//         │                       ├────────srcdoc─────────►│
//         │◄─────────LOAD─────────┤                        │
//         │                       │                        │
//         ├──────────────────PORT (transferred)───────────►│
//         │◄═════════════════════ port ═══════════════════►│
//         │                       │                        │
//         │◄──────ERROR───────────┤◄───────(unread)────────┤
//
// The host and the guest hold the two ends of a `MessagePort` and every
// capability request, response, and event crosses on it. The outer frame
// carries the CSP and loads documents; it relays nothing that protocol says.
//
// The one thing it does pass along is whatever the guest posts to it, which it
// forwards without reading. A guest has a port for everything it means to say,
// so a message arriving by that route is a guest reporting that it could not
// use the port -- a way to raise an alarm, not a second way to talk.

/**
 * Sent alongside the transferred port, so a guest recognizes the handoff by
 * what the message says rather than by having to treat every arriving message
 * as a candidate.
 */
export const GUEST_PORT_HANDOFF = "common-iframe-sandbox:port";

export enum IPCHostMessageType {
  // Host instructing the outer frame to load a new document.
  LoadDocument = "load-document",
}

/** A message from the host to the outer frame. */
export type IPCHostMessage = {
  type: IPCHostMessageType.LoadDocument;
  data: string;
};

export enum IPCGuestMessageType {
  // Outer frame alerting the host that it is ready.
  Ready = "ready",
  // Outer frame's inner document has loaded, so there is a guest to hand a
  // port to.
  Load = "load",
  // An error in the outer frame itself.
  OuterError = "outer-error",
  // An error the guest raised outside its port.
  GuestError = "guest-error",
}

/** A message from the outer frame to the host. */
export type IPCGuestMessage =
  | { type: IPCGuestMessageType.Ready }
  | { type: IPCGuestMessageType.Load }
  | { type: IPCGuestMessageType.OuterError; data: unknown }
  | { type: IPCGuestMessageType.GuestError; data: unknown };

export function isIPCGuestMessage(
  message: unknown,
): message is IPCGuestMessage {
  if (
    typeof message !== "object" || message === null || !("type" in message)
  ) {
    return false;
  }
  switch (message.type) {
    case IPCGuestMessageType.Ready:
    case IPCGuestMessageType.Load: {
      return true;
    }
    case IPCGuestMessageType.OuterError:
    case IPCGuestMessageType.GuestError: {
      return "data" in message && message.data != null;
    }
  }
  return false;
}

export type GuestError = {
  description: string;
  source: string;
  lineno: number;
  colno: number;
  stacktrace: string;
};

export function isGuestError(e: object): e is GuestError {
  return typeof e === "object" &&
    e !== null &&
    "description" in e && typeof e.description === "string" &&
    "source" in e && typeof e.source === "string" &&
    "lineno" in e && typeof e.lineno === "number" &&
    "colno" in e && typeof e.colno === "number" &&
    "stacktrace" in e && typeof e.stacktrace === "string";
}

export const BRIDGE_PROTOCOL = "common-fabric-bridge";
export const BRIDGE_VERSION = 1;

export type BridgeError = {
  code: string;
  message: string;
  resource?: string;
};

export type BridgeResourceDescriptor = {
  name: string;
  kind: "cell" | "stream" | "sqlite" | "service";
  methods: string[];
  schema?: FabricValue;
  description?: string;
};

export type BridgeManifest = {
  protocol: typeof BRIDGE_PROTOCOL;
  version: typeof BRIDGE_VERSION;
  resources: BridgeResourceDescriptor[];
};

export type BridgeOperation =
  | "describe"
  | "disconnect"
  | "read"
  | "write"
  | "call"
  | "subscribe"
  | "unsubscribe";

export type BridgeRequest = {
  protocol: typeof BRIDGE_PROTOCOL;
  version: typeof BRIDGE_VERSION;
  type: "request";
  id: number;
  operation: BridgeOperation;
  resource?: string;
  method?: string;
  subscription?: string;
  value?: FabricValue;
};

export type BridgeResponse = {
  protocol: typeof BRIDGE_PROTOCOL;
  version: typeof BRIDGE_VERSION;
  type: "response";
  id: number;
  ok: true;
  value?: FabricValue;
} | {
  protocol: typeof BRIDGE_PROTOCOL;
  version: typeof BRIDGE_VERSION;
  type: "response";
  id: number;
  ok: false;
  error: BridgeError;
};

export type BridgeEvent = {
  protocol: typeof BRIDGE_PROTOCOL;
  version: typeof BRIDGE_VERSION;
  type: "event";
  subscription: string;
  value?: FabricValue;
};

export type BridgeHostMessage = BridgeResponse | BridgeEvent;

const hasBridgeHeader = (
  message: unknown,
): message is Record<string, unknown> =>
  typeof message === "object" && message !== null &&
  (message as Record<string, unknown>).protocol === BRIDGE_PROTOCOL &&
  (message as Record<string, unknown>).version === BRIDGE_VERSION;

export function isBridgeRequest(message: unknown): message is BridgeRequest {
  if (!hasBridgeHeader(message)) return false;
  if (
    message.type !== "request" || !Number.isSafeInteger(message.id) ||
    typeof message.operation !== "string"
  ) return false;
  switch (message.operation) {
    case "describe":
    case "disconnect":
      return true;
    case "read":
    case "write":
      return typeof message.resource === "string";
    case "call":
      return typeof message.resource === "string" &&
        typeof message.method === "string";
    case "subscribe":
    case "unsubscribe":
      return typeof message.resource === "string" &&
        typeof message.subscription === "string";
    default:
      return false;
  }
}

export function isBridgeHostMessage(
  message: unknown,
): message is BridgeHostMessage {
  if (!hasBridgeHeader(message)) return false;
  if (message.type === "event") {
    return typeof message.subscription === "string";
  }
  if (
    message.type !== "response" || !Number.isSafeInteger(message.id) ||
    typeof message.ok !== "boolean"
  ) return false;
  if (message.ok) return true;
  return typeof message.error === "object" && message.error !== null &&
    typeof (message.error as BridgeError).code === "string" &&
    typeof (message.error as BridgeError).message === "string" &&
    (!("resource" in message.error) ||
      typeof (message.error as BridgeError).resource === "string");
}

export type GuestAlarm = { type: "error"; data: GuestError };

export function isGuestAlarm(message: unknown): message is GuestAlarm {
  return typeof message === "object" && message !== null &&
    (message as { type?: unknown }).type === "error" &&
    "data" in message && isGuestError(message.data as object);
}
