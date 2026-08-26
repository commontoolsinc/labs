/**
 * Event message types for DOM events sent from main thread to worker.
 *
 * When a DOM event fires on the main thread, it is serialized and
 * sent to the worker thread for dispatch to the appropriate handler.
 */

import type { FabricValue } from "@commonfabric/data-model/fabric-value";
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
  detail?: FabricValue;
}

export type { EventProvenance };

/**
 * Serialized event target data.
 * Contains common input element properties.
 */
export interface SerializedEventTarget {
  name?: string;
  /**
   * The element's current value. A `FabricValue` rather than a string: a custom
   * element chooses what its `value` is, and a `cf-input`, a `cf-tabs` and a
   * `cf-calendar` each declare theirs as `CellHandle<string> | string`, which
   * arrives here as the sigil link the conversion resolved it to.
   */
  value?: FabricValue;
  /**
   * Whether the element is checked -- or, where the element chose to expose
   * something else, what it chose. `cf-checkbox` and `cf-switch` each declare
   * theirs as `CellHandle<boolean> | boolean`.
   */
  checked?: FabricValue;
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

  // Copy allowlisted event properties
  for (const prop of ALLOWLISTED_EVENT_PROPERTIES) {
    const value = (event as unknown as Record<string, unknown>)[prop];
    if (value !== undefined) {
      (serialized as unknown as Record<string, unknown>)[prop] = value;
    }
  }

  // Copy target properties
  const target = event.target;
  if (target && typeof target === "object") {
    const serializedTarget: SerializedEventTarget = {};
    let hasTargetProps = false;

    for (const prop of ALLOWLISTED_TARGET_PROPERTIES) {
      const value = (target as unknown as Record<string, unknown>)[prop];
      if (value !== undefined) {
        // Converted like `detail` below, and for the same reason: a `value` is
        // a whole value a component chose to expose, not necessarily a string.
        // A `cf-input`, a `cf-tabs` and a `cf-calendar` each declare theirs as
        // `CellHandle<string> | string`, and a `CellHandle` reaches the pattern
        // as the sigil link its `toJSON()` produces, which the worker resolves.
        (serializedTarget as unknown as Record<string, unknown>)[prop] =
          toSerializableValue(value);
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

  // TODO(danfuzz): a `detail` is a whole value a component chose to hand the
  // pattern, and the pattern's handler receives it as a `FabricValue`. The
  // conversion below narrows it to the JSON-compatible subset on the way in: a
  // `bigint` throws out of `JSON.stringify()` and lands in the `catch`, which
  // replaces the entire detail with `String(detail)`, and a `FabricBytes`
  // stringifies to `{}`. The crossing is `postMessage`, not JSON text, so
  // `codec-realm` carries the whole domain here; what has to stay is the
  // separate job the conversion does of turning an unencodable detail into
  // something rather than failing the event. The same holds of a target's
  // `value` and `checked` above. The outbound half of this seam is marked on
  // `SetPropOp` in `../vdom-ops.ts`.
  if ("detail" in event && (event as CustomEvent).detail !== undefined) {
    serialized.detail = toSerializableValue((event as CustomEvent).detail);
  }

  return serialized;
}

/**
 * Converts one value a component exposed to the event into a form the VDOM
 * event notification can carry, substituting a description for anything with
 * no conversion at all. Handing the pattern something is the point: an event
 * whose value cannot cross is still an event the handler should see.
 */
function toSerializableValue(value: unknown): FabricValue {
  try {
    // The round trip resolves whatever `toJSON()` a value defines -- a
    // `CellHandle` becomes its sigil link -- and drops what JSON has no
    // representation for. `undefined` comes back from `JSON.stringify()` for a
    // function or a symbol, and a circular reference or a throwing `toJSON()`
    // lands in the `catch`.
    const jsonString = JSON.stringify(value);
    return jsonString !== undefined ? JSON.parse(jsonString) : String(value);
  } catch {
    return String(value);
  }
}
