/**
 * The shape of the event value the renderer builds out of a browser event.
 *
 * A DOM event is not a JSON value and cannot cross the worker boundary, so
 * `serializeEvent` (main/events.ts) copies an allowlisted subset of it into a
 * plain object. Every key of that object comes from the renderer, never from
 * the pattern author: the author wires a stream to `onClick`, and the runtime
 * decides what the click looks like.
 *
 * That authorship is why the lists live here rather than beside the
 * serializer. The worker side needs the same set to mint the send's
 * injection-provenance marker (`markRuntimeInjectedEventKeys`), which exempts
 * these keys — and only these — from a verb's closed event schema, and the
 * worker must not import the main thread's DOM code to learn it. Adding a
 * property to `serializeEvent` means adding it here too; forgetting fails
 * closed, with the new key rejected by the closed-world gate.
 */

/** Event properties `serializeEvent` copies straight off the DOM event. */
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

/** Event-target properties `serializeEvent` copies into `target`. */
export const ALLOWLISTED_TARGET_PROPERTIES = [
  "name",
  "value",
  "checked",
  "selected",
  "selectedIndex",
] as const;

/**
 * Every top-level key a serialized DOM event can carry: the properties copied
 * off the event itself, plus the three the serializer composes — the renderer's
 * `provenance` hint, the `target` projection, and `detail`.
 */
export const SERIALIZED_EVENT_KEYS = [
  ...ALLOWLISTED_EVENT_PROPERTIES,
  "provenance",
  "target",
  "detail",
] as const;
