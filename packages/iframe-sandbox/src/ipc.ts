// Types used by the `common-iframe-sandbox` IPC.

import type { RealmEncodedValue } from "@commonfabric/data-model/codec-realm";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";

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

/**
 * Messages from the system to the host. In case of passthrough it is system
 * sending message to the guest through the host.
 */
export type IPCHostMessage =
  | { id: number; type: IPCHostMessageType.Init }
  | { id: number; type: IPCHostMessageType.LoadDocument; data: string }
  | {
    id: number;
    type: IPCHostMessageType.Passthrough;
    // A `HostMessage`, `codec-realm`-encoded. The outer frame routes on the
    // fields beside this one and hands this through untouched, so the whole
    // message crosses as one encoding rather than the guest reassembling a
    // plain wrapper around an encoded part.
    data: RealmEncodedValue;
  };

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

/**
 * Messages from the host to the system and in case of pass through it is guest
 * message routed through the host.
 */
export type IPCGuestMessage =
  | { type: IPCGuestMessageType.Ready }
  | { id: number; type: IPCGuestMessageType.Load }
  | { id: number; type: IPCGuestMessageType.Error; data: unknown }
  | {
    id: number;
    type: IPCGuestMessageType.Passthrough;
    // A `GuestMessage`, `codec-realm`-encoded, as the host's `Passthrough` arm
    // carries a `HostMessage`. What decodes is checked by `isGuestMessage()`.
    data: RealmEncodedValue;
  };

export function isIPCGuestMessage(
  message: unknown,
): message is IPCGuestMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  if (!("type" in message)) {
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
      return ("id" in message) && message.id != null;
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

export function isGuestError(e: FabricValue): e is GuestError {
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
 * value read for it. `GuestMessage`'s `Write` arm is the same value going the
 * other way.
 *
 * This is a `FabricValue` whole, and crosses as one `codec-realm` encoding;
 * see the `Passthrough` arm of {@link IPCHostMessage} for the form on the
 * wire.
 */
export type HostMessage = {
  type: HostMessageType.Update;
  data: [string, FabricValue];
};

/**
 * Is `message` a {@link HostMessage}? Takes what a decode produced, a guest
 * having no reason to trust that what decoded is what this protocol writes.
 */
export function isHostMessage(message: FabricValue): message is HostMessage {
  return typeof message === "object" && message !== null &&
    !Array.isArray(message) &&
    (message as { type?: unknown }).type === HostMessageType.Update &&
    Array.isArray((message as { data?: unknown }).data) &&
    (message as { data: FabricValue[] }).data.length === 2 &&
    typeof (message as { data: FabricValue[] }).data[0] === "string";
}

export enum GuestMessageType {
  Error = "error",
  Subscribe = "subscribe",
  Unsubscribe = "unsubscribe",
  Write = "write",
  Read = "read",
}

/**
 * A message the guest passes through to the host. Each arm is a `FabricValue`
 * whole, and crosses as one `codec-realm` encoding; see the `Passthrough` arm
 * of {@link IPCGuestMessage} for the form on the wire.
 */
export type GuestMessage =
  | { type: GuestMessageType.Error; data: GuestError }
  | { type: GuestMessageType.Subscribe; data: string | string[] }
  | { type: GuestMessageType.Unsubscribe; data: string | string[] }
  | { type: GuestMessageType.Read; data: string }
  | { type: GuestMessageType.Write; data: [string, FabricValue] };

/**
 * Is `message` a {@link GuestMessage}? Takes what a decode produced; the guest
 * is untrusted, so what decoded is a claim about this protocol rather than a
 * fact of it.
 */
export function isGuestMessage(message: FabricValue): message is GuestMessage {
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
