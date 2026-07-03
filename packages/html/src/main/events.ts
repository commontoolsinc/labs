/**
 * Event message types for DOM events sent from main thread to worker.
 *
 * When a DOM event fires on the main thread, it is serialized and
 * sent to the worker thread for dispatch to the appropriate handler.
 */

import type { JSONValue } from "@commonfabric/runtime-client";
import {
  type EventProvenance,
  getEventProvenance,
  getEventTargetDataset,
} from "../event-provenance.ts";

/**
 * Serialized DOM event data.
 * Contains a subset of event properties that are safe to serialize.
 */
export interface SerializedEvent {
  /** Event type (e.g., "click", "input", "change") */
  type: string;
  /** Internal provenance hint from the renderer */
  provenance?: EventProvenance;

  // Keyboard event properties
  key?: string;
  code?: string;
  repeat?: boolean;

  // Modifier keys (keyboard & mouse)
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;

  // Input event properties
  inputType?: string;
  data?: string | null;

  // Mouse event properties
  button?: number;
  buttons?: number;

  // Target properties
  target?: SerializedEventTarget;

  // Custom event detail
  detail?: JSONValue;
}

export type { EventProvenance };

/**
 * Serialized event target data.
 * Contains common input element properties.
 */
export interface SerializedEventTarget {
  name?: string;
  value?: string;
  checked?: boolean;
  selected?: boolean;
  selectedIndex?: number;
  selectedOptions?: { value: string }[];
  dataset?: Record<string, string>;
}

/**
 * Message sent from main thread to worker when a DOM event fires.
 */
export interface DomEventMessage {
  type: "dom-event";

  /** The handler ID that should process this event */
  handlerId: number;

  /** The serialized event data */
  event: SerializedEvent;

  /** The node ID where the event occurred */
  nodeId: number;
}

/**
 * Type guard for DomEventMessage.
 */
export function isDomEventMessage(value: unknown): value is DomEventMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const msg = value as DomEventMessage;
  return (
    msg.type === "dom-event" &&
    typeof msg.handlerId === "number" &&
    typeof msg.event === "object" &&
    msg.event !== null &&
    typeof msg.nodeId === "number"
  );
}

/**
 * Allowlisted event properties that can be serialized.
 * These are the standard properties we copy from events.
 */
export const ALLOWLISTED_EVENT_PROPERTIES = [
  "type",
  "key",
  "code",
  "repeat",
  "altKey",
  "ctrlKey",
  "metaKey",
  "shiftKey",
  "inputType",
  "data",
  "button",
  "buttons",
] as const;

/**
 * Allowlisted event target properties that can be serialized.
 */
export const ALLOWLISTED_TARGET_PROPERTIES = [
  "name",
  "value",
  "checked",
  "selected",
  "selectedIndex",
] as const;

/**
 * Serialize a DOM event for IPC transmission.
 * This creates a plain object with only safe, serializable properties.
 */
export function serializeEvent(event: Event): SerializedEvent {
  const serialized: SerializedEvent = {
    type: event.type,
  };
  const provenance = getEventProvenance(event, event.target);
  if (provenance) {
    serialized.provenance = provenance;
  }

  const eventRecord = event as object as Record<string, unknown>;
  const serializedRecord = serialized as object as Record<string, unknown>;

  // Copy allowlisted event properties
  for (const prop of ALLOWLISTED_EVENT_PROPERTIES) {
    const value = eventRecord[prop];
    if (value !== undefined) {
      serializedRecord[prop] = value;
    }
  }

  // Copy target properties
  const target = event.target;
  if (target && typeof target === "object") {
    const serializedTarget: SerializedEventTarget = {};
    const targetRecord = target as object as Record<string, unknown>;
    const serializedTargetRecord = serializedTarget as object as Record<
      string,
      unknown
    >;
    let hasTargetProps = false;

    for (const prop of ALLOWLISTED_TARGET_PROPERTIES) {
      const value = targetRecord[prop];
      if (value !== undefined) {
        serializedTargetRecord[prop] = value;
        hasTargetProps = true;
      }
    }

    // Handle select element's selectedOptions
    if (
      "selectedOptions" in target &&
      target.selectedOptions instanceof HTMLCollection
    ) {
      serializedTarget.selectedOptions = Array.from(target.selectedOptions).map(
        (option) => ({ value: (option as HTMLOptionElement).value }),
      );
      hasTargetProps = true;
    }

    // Handle the event target's own dataset. UI contract markers from the
    // composed path are serialized separately in provenance.
    const dataset = getEventTargetDataset(target);
    if (dataset) {
      serializedTarget.dataset = dataset;
      hasTargetProps = true;
    }

    if (hasTargetProps) {
      serialized.target = serializedTarget;
    }
  }

  // Handle CustomEvent detail - ensure it's JSON-serializable
  if ("detail" in event && (event as CustomEvent).detail !== undefined) {
    const detail = (event as CustomEvent).detail;
    try {
      // Use JSON round-trip to get a clean JSON value
      // This handles: functions (stringify returns undefined), symbols, circular refs
      const jsonString = JSON.stringify(detail);
      if (jsonString !== undefined) {
        serialized.detail = JSON.parse(jsonString);
      } else {
        // Functions/symbols return undefined from stringify - convert to string
        serialized.detail = String(detail);
      }
    } catch {
      // Circular refs or other errors - convert to string representation
      serialized.detail = String(detail);
    }
  }

  return serialized;
}
