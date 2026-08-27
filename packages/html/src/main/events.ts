/**
 * Event message types for DOM events sent from main thread to worker.
 *
 * When a DOM event fires on the main thread, it is serialized and
 * sent to the worker thread for dispatch to the appropriate handler.
 */

import {
  fabricFromNativeValue,
  FabricInstance,
  type FabricValue,
} from "@commonfabric/data-model/fabric-value";
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
        // The outbound half of this seam is closed the same way: `SetPropOp`'s
        // `value` in `../vdom-ops.ts` is a `FabricValue` the envelope carries.
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

  if ("detail" in event && (event as CustomEvent).detail !== undefined) {
    serialized.detail = toSerializableValue((event as CustomEvent).detail);
  }

  return serialized;
}

/**
 * Converts one value a component exposed to the event into the form the VDOM
 * event notification carries, substituting a description for anything with no
 * conversion at all. Handing the pattern something is the point: an event whose
 * value cannot cross is still an event the handler should see.
 *
 * Two conversions, in this order. The round trip goes first and answers for
 * everything it can: it resolves whatever `toJSON()` a value defines -- a
 * `CellHandle` becoming the sigil link the worker resolves -- and it is what
 * a value reaching a handler has always been rendered by.
 *
 * The fabric conversion answers for what the round trip refuses, which is where
 * the crossing being `postMessage` rather than JSON text starts to matter: a
 * `bigint` anywhere inside a value throws out of `JSON.stringify()`, and
 * without a second answer the whole value becomes a description of itself. It
 * refuses a circular reference in turn, which is what keeps one from reaching a
 * crossing that has no representation for it.
 *
 * What the far side accepts is narrower than what the fabric conversion
 * produces, and {@link holdsFabricInstance} is where that is enforced: a value
 * carrying an instance is described instead, which is what a value reaching
 * here has always been rendered as when nothing else could render it.
 *
 * TODO(danfuzz): once the ingress descends an instance rather than refusing
 * one, that guard goes, the fabric conversion can go first, and a `FabricBytes`
 * in a detail stops arriving as `{}`.
 */
function toSerializableValue(value: unknown): FabricValue {
  try {
    const jsonString = JSON.stringify(value);
    if (jsonString !== undefined) return JSON.parse(jsonString);
  } catch {
    // Answered below, first by the fabric conversion and then as a value with
    // no rendering at all.
  }

  try {
    const fabric = fabricFromNativeValue(value);
    if (!holdsFabricInstance(fabric)) return fabric;
  } catch {
    // Described below, as a value with neither rendering is.
  }

  return describeUnconvertible(value);
}

/**
 * Whether a value holds a `FabricInstance` anywhere within it.
 *
 * The worker's event ingress refuses one -- `stripSigilCfcLabelViews()` in
 * `@commonfabric/runner/cfc`, whose refusal is the tripwire naming the
 * codec-mediated traversal it owes -- so an event carrying one is dropped
 * rather than delivered. The conversion above mints a `FabricError` from an
 * `Error`, and an `Error` in a detail is ordinary: `cf-file-input` dispatches
 * `cf-error` with one. The round trip renders such a value first and gets
 * there for its own reasons, which covers the plain case; this covers the rest,
 * where the round trip refused the value for something else it held.
 *
 * No cycle tracking, the conversion having refused a circular reference before
 * this is reached. Shared structure is walked once per position rather than
 * once, which an event payload is small enough not to notice.
 */
function holdsFabricInstance(value: unknown): boolean {
  if (value instanceof FabricInstance) return true;
  if (value === null || typeof value !== "object") return false;

  // A `FabricPrimitive` has no enumerable own properties, so it reports `false`
  // from here without an arm of its own.
  return Object.values(value).some(holdsFabricInstance);
}

/**
 * Renders a value with no JSON form as text, for a description that must be
 * produced whatever it is handed.
 *
 * A value can refuse even to be coerced: `String()` reaches for `toString` and
 * `valueOf`, and an object made with `Object.create(null)` has no prototype to
 * find either on. `/unconvertible` is the fixed token for that.
 */
function describeUnconvertible(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "/unconvertible";
  }
}
