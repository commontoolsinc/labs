import { type JSONSchema } from "@commontools/runner";
import { isObject } from "@commontools/utils/types";

export const isJSONSchema = (source: unknown): source is JSONSchema => {
  if (!isObject(source)) {
    return false;
  }

  if (!("type" in source) || !source.type) {
    return "anyOf" in source && Array.isArray(source.anyOf);
  }

  switch (source.type) {
    case "object":
    case "array":
    case "string":
    case "integer":
    case "number":
    case "boolean":
    case "null":
      return true;
    default:
      return false;
  }
};

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

/**
 * Messages from the system to the host. In case of passthrough it is system
 * sending message to the guest through the host.
 */
export type IPCHostMessage =
  | { id: number; type: IPCHostMessageType.Init }
  | { id: number; type: IPCHostMessageType.LoadDocument; data: string }
  | { id: number; type: IPCHostMessageType.Passthrough; data: HostMessage };

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
  | { id: number; type: IPCGuestMessageType.Passthrough; data: GuestMessage };

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
      if (
        message.type === IPCGuestMessageType.Passthrough &&
        "data" in message &&
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

export const isTaskPerform = (source: unknown): source is TaskPerform =>
  isObject(source) &&
  "intent" in source && typeof source.intent === "string" &&
  "description" in source && typeof source.description === "string" &&
  "input" in source && isObject(source.input) &&
  "output" in source && isJSONSchema(source.output);

export enum HostMessageType {
  Ping = "ping",
  Update = "update",
  LLMResponse = "llm-response",
  ReadWebpageResponse = "readwebpage-response",
  Effect = "command-effect",
}

export type HostMessage =
  | { type: HostMessageType.Ping; data: string }
  | { type: HostMessageType.Update; data: [string, unknown] }
  | {
    type: HostMessageType.LLMResponse;
    request: string;
    data: object | null;
    error: unknown;
  }
  | {
    type: HostMessageType.ReadWebpageResponse;
    request: string;
    data: object | null;
    error: unknown;
  }
  | Effect;

export type Effect = {
  type: HostMessageType.Effect;
  /**
   * ID of the corresponding GuestCommand.
   */
  id: string;

  /**
   * Result of performing the GuestCommand. It MUST match the `output` schema
   * provided by the command. It is expected that system will ensure schema
   * conformance but there is no way for us to ensure this on wire.
   */
  result: { ok: object; error?: void } | { error: Error; ok?: void };
};

export enum GuestMessageType {
  Error = "error",
  Subscribe = "subscribe",
  Unsubscribe = "unsubscribe",
  Write = "write",
  Read = "read",
  LLMRequest = "llm-request",
  WebpageRequest = "readwebpage-request",
  Perform = "perform",
  Pong = "pong",
}

export type GuestMessage =
  | { type: GuestMessageType.Error; data: GuestError }
  | { type: GuestMessageType.Subscribe; data: string | string[] }
  | { type: GuestMessageType.Unsubscribe; data: string | string[] }
  | { type: GuestMessageType.Read; data: string }
  | { type: GuestMessageType.Write; data: [string, unknown] }
  | { type: GuestMessageType.LLMRequest; data: string }
  | { type: GuestMessageType.WebpageRequest; data: string }
  | { type: GuestMessageType.Perform; data: TaskPerform }
  | { type: GuestMessageType.Pong; data: string };

/**
 * Message asking a host to perform certain task.
 */
export interface TaskPerform {
  /**
   * Intent is a semantic identifier that describes the task guest wishes
   * to be performed.
   */
  intent: string;

  /**
   * Description of the expected effect performing this command should have.
   */
  description: string;

  /**
   * Parameters of the command.
   */
  input: object;

  /**
   * A schema of the result produced by this effect.
   */
  output: JSONSchema;

  /**
   * Unique identifier for this command. It is used by the host to send
   * corresponding effect message.
   */
  id: string;
}

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
    case GuestMessageType.LLMRequest:
    case GuestMessageType.WebpageRequest:
    case GuestMessageType.Read:
    case GuestMessageType.Pong: {
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
    case GuestMessageType.Perform: {
      return isTaskPerform(message.data);
    }
  }

  return false;
}
