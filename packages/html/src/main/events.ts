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
} from "./event-provenance.ts";

/**
 * Serialized DOM event data.
 * Contains a subset of event properties that are safe to serialize.
 */
export type SerializedEvent = {
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
};

export type { EventProvenance };

/**
 * Serialized event target data.
 * Contains common input element properties.
 */
export type SerializedEventTarget = {
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

  /** Whether the element reports itself selected. */
  selected?: boolean;

  /**
   * Which option a select is on -- or, where the element chose to expose
   * something else, what it chose. `cf-picker` declares its `selectedIndex` as
   * a `CellHandle<number>`, which arrives here as the link that reaches it.
   */
  selectedIndex?: FabricValue;

  /** Every selected option's value, for a multiple select. */
  selectedOptions?: { value: string }[];

  /** The element's `data-` attributes. */
  dataset?: Record<string, string>;
};

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
 * The type the DOM defines for a property, as a tag a read can be checked
 * against. `"string?"` is `string | null`, which is what an input event's
 * `data` is when there is no inserted text.
 */
type DomScalar = "string" | "string?" | "boolean" | "number";

/** Whether a value is what its {@link DomScalar} tag says it is. */
function matchesDomScalar(value: unknown, tag: DomScalar): boolean {
  switch (tag) {
    case "string":
      return typeof value === "string";
    case "string?":
      return (value === null) || (typeof value === "string");
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
  }
}

/**
 * Event properties that cross, each with the type the DOM defines for it. Every
 * one is a `FabricValue`, which is what lets them cross as they are.
 */
export const ALLOWLISTED_EVENT_PROPERTIES = {
  type: "string",
  key: "string",
  code: "string",
  repeat: "boolean",
  altKey: "boolean",
  ctrlKey: "boolean",
  metaKey: "boolean",
  shiftKey: "boolean",
  inputType: "string",
  data: "string?",
  button: "number",
  buttons: "number",
} as const satisfies Partial<Record<keyof SerializedEvent, DomScalar>>;

/**
 * Target properties whose type the DOM fixes, which therefore cross the way the
 * event's own properties do.
 */
export const ALLOWLISTED_TARGET_SCALARS = {
  name: "string",
  selected: "boolean",
} as const satisfies Partial<Record<keyof SerializedEventTarget, DomScalar>>;

/**
 * Target properties a custom element chooses the value of. Each is declared
 * `CellHandle<T> | T` by at least one component -- `value` by eight of them,
 * `checked` by two, `selectedIndex` by `cf-picker` -- so what crosses is
 * whatever {@link toSerializableValue} makes of what is found.
 */
export const ALLOWLISTED_TARGET_EXPOSED = [
  "value",
  "checked",
  "selectedIndex",
] as const satisfies readonly (keyof SerializedEventTarget)[];

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

  // Each checked against the type the DOM defines for it, which is what makes
  // the write the field type `SerializedEvent` declares rather than a claim
  // about it. A property of some other type is one no producer here dispatches,
  // and is left out rather than carried into a field that cannot hold it.
  copyDomScalars(
    event as unknown as Record<string, unknown>,
    serialized as unknown as Record<string, unknown>,
    ALLOWLISTED_EVENT_PROPERTIES,
  );

  // Copy target properties
  const target = event.target;
  if (target && typeof target === "object") {
    const serializedTarget: SerializedEventTarget = {};
    let hasTargetProps = false;

    const from = target as unknown as Record<string, unknown>;
    const to = serializedTarget as unknown as Record<string, unknown>;

    // The ones the DOM fixes the type of, copied as the event's own are.
    hasTargetProps = copyDomScalars(from, to, ALLOWLISTED_TARGET_SCALARS) ||
      hasTargetProps;

    // The ones a custom element chooses the value of, so that what crosses is
    // whatever the conversion makes of what it finds.
    for (const prop of ALLOWLISTED_TARGET_EXPOSED) {
      const value = from[prop];
      if (value !== undefined) {
        to[prop] = toSerializableValue(value);
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
  // `value` and `checked` above. The outbound half of this seam is closed:
  // `SetPropOp.value` in `../vdom-ops.ts` is a `FabricValue` the envelope's
  // encoding carries whole.
  if ("detail" in event && (event as CustomEvent).detail !== undefined) {
    serialized.detail = toSerializableValue((event as CustomEvent).detail);
  }

  return serialized;
}

/**
 * Copies each named property that is present and is what its tag says, and
 * reports whether any was copied.
 *
 * The two casts are the loop's rather than a claim about the values: what is
 * read is a property of whatever object was dispatched, and what is written has
 * been checked before it goes.
 */
function copyDomScalars(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
  tags: Readonly<Record<string, DomScalar>>,
): boolean {
  let copied = false;

  for (const [prop, tag] of Object.entries(tags)) {
    const value = from[prop];
    if ((value !== undefined) && matchesDomScalar(value, tag)) {
      to[prop] = value;
      copied = true;
    }
  }

  return copied;
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
    // throws out of it.
    const jsonString = JSON.stringify(value);
    if (jsonString !== undefined) return JSON.parse(jsonString);
  } catch {
    // Described below, as a value with no JSON form at all is.
  }

  return describeUnconvertible(value);
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
