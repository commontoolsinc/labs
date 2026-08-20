// Types used by the `common-iframe-sandbox` IPC.

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
// message of the key/value protocol -- `HostMessage` and `GuestMessage` --
// crosses on it. The outer frame carries the CSP and loads documents; it
// relays nothing that protocol says.
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
}

/**
 * A message the host passes through to the guest. `data` is a key and the
 * value read for it.
 *
 * TODO(danfuzz): the value is a `FabricValue` -- it comes from a cell, by way
 * of the registered `IframeContextHandler` -- and crosses to the guest by
 * `postMessage()` as itself, so structured clone strips a `FabricPrimitive`
 * to `{}` on the way. `codec-realm` encodes for exactly this crossing;
 * `GuestMessage`'s `Write` arm is the same value going the other way.
 */
export type HostMessage = {
  type: HostMessageType.Update;
  data: [string, unknown];
};

export enum GuestMessageType {
  Error = "error",
  Subscribe = "subscribe",
  Unsubscribe = "unsubscribe",
  Write = "write",
  Read = "read",
}

export type GuestMessage =
  | { type: GuestMessageType.Error; data: GuestError }
  | { type: GuestMessageType.Subscribe; data: string | string[] }
  | { type: GuestMessageType.Unsubscribe; data: string | string[] }
  | { type: GuestMessageType.Read; data: string }
  // TODO(danfuzz): the `Write` value is the inbound half of the gap marked on
  // `HostMessage`, and closed by the same mechanism. It is the weaker half:
  // the guest is untrusted, so what arrives is whatever it sent, and an
  // encoded form gives the host a decode that refuses rather than a value it
  // has to vet by hand.
  | { type: GuestMessageType.Write; data: [string, unknown] };

export function isGuestMessage(message: unknown): message is GuestMessage {
  if (
    typeof message !== "object" ||
    message === null ||
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
    case GuestMessageType.Read: {
      return typeof message.data === "string";
    }
    case GuestMessageType.Subscribe:
    case GuestMessageType.Unsubscribe: {
      return typeof message.data === "string" ||
        (Array.isArray(message.data) &&
          message.data.every((key: unknown) => typeof key === "string"));
    }
    case GuestMessageType.Write: {
      return Array.isArray(message.data) &&
        message.data.length === 2 &&
        typeof message.data[0] === "string";
    }
  }

  return false;
}
