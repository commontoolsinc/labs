import { isObject, isRecord } from "@commontools/utils/types";
import {
  CellHandle,
  isCellHandle,
  UI,
  type VNode,
} from "@commontools/runtime-client";

export type SetPropHandler = <T>(
  target: T,
  key: string,
  value: unknown,
) => void;

/** Create a placeholder element indicating a circular reference was detected */
export const createCyclePlaceholder = (document: Document): HTMLSpanElement => {
  const element = document.createElement("span");
  element.textContent = "🔄";
  element.title = "Circular reference detected";
  return element;
};

export const isEventProp = (key: string) => key.startsWith("on");

/**
 * Get the event type from an event prop name.
 * E.g., "onClick" -> "click", "onMouseMove" -> "mousemove"
 */
export const getEventType = (key: string): string => {
  if (!key.startsWith("on") || key.length <= 2) return key;
  return key.slice(2).toLowerCase();
};

/**
 * Check if a value is an event handler function.
 */
export const isEventHandler = (
  value: unknown,
): value is (event: unknown) => void => {
  return typeof value === "function";
};

/**
 * Check if a prop name is a bidirectional binding (starts with $).
 */
export const isBindingProp = (key: string): boolean => {
  return key.startsWith("$");
};

/**
 * Get the property name from a binding prop.
 * E.g., "$value" -> "value", "$checked" -> "checked"
 */
export const getBindingPropName = (key: string): string => {
  return key.startsWith("$") ? key.slice(1) : key;
};

export const cleanEventProp = (key: string) => {
  if (!key.startsWith("on")) {
    return null;
  }
  return key.slice(2).toLowerCase();
};

/** Attach an event listener, returning a function to cancel the listener */
export const listen = (
  element: HTMLElement,
  key: string,
  callback: (event: Event) => void,
) => {
  element.addEventListener(key, callback);
  return () => {
    element.removeEventListener(key, callback);
  };
};

/**
 * Converts a React-style CSS object to a CSS string.
 * Supports vendor prefixes, pixel value shorthand, and comprehensive CSS properties.
 * @param styleObject - The style object with React-style camelCase properties
 * @returns A CSS string suitable for the style attribute
 */
export const styleObjectToCssString = (
  styleObject: Record<string, any>,
): string => {
  return Object.entries(styleObject)
    .map(([key, value]) => {
      // Skip if value is null or undefined
      if (value == null) return "";

      // Convert camelCase to kebab-case, handling vendor prefixes
      let cssKey = key;

      // CSS custom properties (--*) are case-sensitive and should not be transformed
      if (!key.startsWith("--")) {
        // Handle vendor prefixes (WebkitTransform -> -webkit-transform)
        if (/^(webkit|moz|ms|o)[A-Z]/.test(key)) {
          cssKey = "-" + key;
        }

        // Convert camelCase to kebab-case
        cssKey = cssKey.replace(/([A-Z])/g, "-$1").toLowerCase();
      }

      // Convert value to string
      let cssValue = value;

      // Add 'px' suffix to numeric values for properties that need it
      // Exceptions: properties that accept unitless numbers
      const unitlessProperties = new Set([
        "animation-iteration-count",
        "column-count",
        "fill-opacity",
        "flex",
        "flex-grow",
        "flex-shrink",
        "font-weight",
        "line-height",
        "opacity",
        "order",
        "orphans",
        "stroke-opacity",
        "widows",
        "z-index",
        "zoom",
      ]);

      if (
        typeof value === "number" &&
        !cssKey.startsWith("--") && // CSS custom properties should never get px
        !unitlessProperties.has(cssKey) &&
        value !== 0
      ) {
        cssValue = `${value}px`;
      } else {
        cssValue = String(value);
      }

      return `${cssKey}: ${cssValue}`;
    })
    .filter((s) => s !== "")
    .join("; ");
};

export const setPropDefault = <T>(target: T, key: string, value: unknown) => {
  // Handle style object specially - set as attribute.
  if (
    key === "style" &&
    target instanceof HTMLElement &&
    typeof value === "string"
  ) {
    if (target.getAttribute("style") !== value) {
      target.setAttribute("style", value);
    }
    return;
  }

  // Handle data-* attributes specially - they need to be set as HTML attributes
  // to populate the dataset property correctly
  if (key.startsWith("data-") && target instanceof Element) {
    // If value is null or undefined, remove the attribute
    if (value == null) {
      if (target.hasAttribute(key)) {
        target.removeAttribute(key);
      }
    } else {
      const currentValue = target.getAttribute(key);
      const newValue = String(value);
      if (currentValue !== newValue) {
        target.setAttribute(key, newValue);
      }
    }
  } else if (target[key as keyof T] !== value) {
    target[key as keyof T] = value as T[keyof T];
  }
};

export const sanitizeNode = (node: VNode): VNode | null => {
  if (node.type !== "vnode" || node.name === "script") {
    return null;
  }
  // Fragments (`<></>`) appear as VNodes with
  // no name property. Rewrite to `ct-fragment`.
  if (!node.name) {
    node.name = "ct-fragment";
  }
  if (!isCellHandle(node.props) && !isObject(node.props)) {
    node = { ...node, props: {} };
  }
  if (!isCellHandle(node.children) && !Array.isArray(node.children)) {
    node = { ...node, children: [] };
  }

  return node;
};

const allowListedEventProperties = [
  "type", // general
  "key", // keyboard event
  "code", // keyboard event
  "repeat", // keyboard event
  "altKey", // keyboard & mouse event
  "ctrlKey", // keyboard & mouse event
  "metaKey", // keyboard & mouse event
  "shiftKey", // keyboard & mouse event
  "inputType", // input event
  "data", // input event
  "button", // mouse event
  "buttons", // mouse event
];

const allowListedEventTargetProperties = [
  "name", // general input
  "value", // general input
  "checked", // checkbox
  "selected", // option
  "selectedIndex", // select
];

/**
 * Sanitize an event so it can be serialized.
 *
 * NOTE: This isn't yet vetted for security, it's just a coarse first pass with
 * the primary objective of making events serializable.
 *
 * E.g. one glaring omission is that this can leak data via bubbling and we
 * should sanitize quite differently if the target isn't the same as
 * eventTarget.
 *
 * This code also doesn't make any effort to only copy properties that are
 * allowed on various event types, or otherwise tailor sanitization to the event
 * type.
 *
 * @param event - The event to sanitize.
 * @returns The serializable event.
 */
export function sanitizeEvent(event: Event): object {
  const eventObject: Record<string, unknown> = {};
  for (const property of allowListedEventProperties) {
    eventObject[property] = event[property as keyof Event];
  }

  const targetObject: Record<string, unknown> = {};
  for (const property of allowListedEventTargetProperties) {
    targetObject[property] = event.target?.[property as keyof EventTarget];
  }

  const { target } = event;

  if (isSelectElement(target) && target.selectedOptions) {
    // To support multiple selections, we create serializable option elements
    targetObject.selectedOptions = Array.from(target.selectedOptions)
      .map(
        (option) => ({ value: option.value }),
      );
  }

  // Copy dataset as a plain object for serialization
  if (isObject(target) && "dataset" in target && isRecord(target.dataset)) {
    const dataset: Record<string, string> = {};
    for (const key in target.dataset) {
      // String() to normalize, just in case
      dataset[key] = String(target.dataset[key]);
    }
    if (Object.keys(dataset).length > 0) {
      targetObject.dataset = dataset;
    }
  }

  if (Object.keys(targetObject).length > 0) eventObject.target = targetObject;

  if ((event as CustomEvent).detail !== undefined) {
    // Could be anything, but should only come from our own custom elements.
    // Step below will remove any direct references.
    eventObject.detail = (event as CustomEvent).detail;
  }

  return eventObject;
}

export function isSelectElement(value: unknown): value is HTMLSelectElement {
  return !!(value && typeof value === "object" && ("tagName" in value) &&
    typeof value.tagName === "string" &&
    value.tagName.toUpperCase() === "SELECT");
}

// Some objects in the system look like
// `{ "$NAME": "<ref>", "$UI": <ref> }` as VNodes, but lack
// a `type = "vnode"`. This checks for type, $UI property.
export function isVNodeish(value: unknown): value is VNode {
  if (!isObject(value)) return false;
  if ((value as VNode).type === "vnode") return true;
  if (UI in value && value[UI]) return true;
  return false;
}

export function hasVisitedCell(
  visited: Set<object>,
  cell: { equals(other: unknown): boolean },
): boolean {
  for (const item of visited) {
    if (cell.equals(item)) {
      return true;
    }
  }
  return false;
}

export function stringifyText(
  value: string | boolean | null | undefined | number | object | any[],
): string {
  if (typeof value === "string") {
    return value;
  } else if (
    value === null || value === undefined ||
    value === false
  ) {
    return "";
  } else if (typeof value === "object") {
    // Handle unresolved alias objects gracefully - render empty until resolved
    if (value && "$alias" in value) {
      return "";
    } else {
      console.warn(
        "unexpected object when value was expected",
        value,
      );
      return JSON.stringify(value);
    }
  }
  return value.toString();
}

export type Cancel = () => void;
export const noop = () => {};

/**
 * Effect that runs a callback when the value changes. The callback is also
 * called immediately. CellHandle version of `runner`'s Reactivity features.
 */
export const effect = <T>(
  value: CellHandle<T> | T,
  callback: (value: T | undefined) => Cancel | undefined | void,
): Cancel => {
  if (isCellHandle<T>(value)) {
    return value.subscribe(callback);
  } else {
    const cancel = callback(value as T);
    return typeof cancel === "function" && cancel.length === 0 ? cancel : noop;
  }
};
