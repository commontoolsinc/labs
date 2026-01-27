/**
 * Worker-side JSX factory function.
 *
 * This is the worker-thread version of the h() function that creates
 * WorkerVNode structures. It accepts Cell<T> values instead of CellHandle<T>,
 * and performs validation for $prop bidirectional bindings.
 */

import { isCell, isCellResult } from "@commontools/runner";
import type {
  WorkerJSXElement,
  WorkerProps,
  WorkerRenderNode,
  WorkerVNode,
} from "./types.ts";

/**
 * Fragment element name used for JSX fragments.
 */
export const FRAGMENT_ELEMENT = "ct-fragment";

/**
 * Type for a component function that receives props and returns JSX.
 */
export type WorkerComponent<P = Record<string, unknown>> = (
  props: P & { children?: WorkerRenderNode[] },
) => WorkerJSXElement;

/**
 * H function overload signatures.
 */
export interface WorkerHFunction {
  // Component function
  <P extends Record<string, unknown>>(
    name: WorkerComponent<P>,
    props: P | null,
    ...children: WorkerRenderNode[]
  ): WorkerJSXElement;

  // Element string
  (
    name: string,
    props: WorkerProps | null,
    ...children: WorkerRenderNode[]
  ): WorkerVNode;

  // Fragment support
  fragment(props: { children: WorkerRenderNode[] }): WorkerVNode;
}

/**
 * JSX factory function for creating worker VDOM nodes.
 *
 * @param name - The element name or component function
 * @param props - Element properties (can contain Cell values)
 * @param children - Child elements
 * @returns A WorkerVNode or the result of calling a component function
 */
export const h: WorkerHFunction = Object.assign(
  function h(
    name: string | WorkerComponent,
    props: WorkerProps | null,
    ...children: WorkerRenderNode[]
  ): WorkerJSXElement {
    if (typeof name === "function") {
      // Component function - call it with props and children
      return name({
        ...(props ?? {}),
        children: children.flat(),
      });
    } else {
      // Element - validate and create VNode
      props ??= {};

      // Validate $prop bindings
      const propKeys = Object.keys(props).filter((key) => key.startsWith("$"));
      for (const key of propKeys) {
        const value = props[key];
        validateBidirectionalBinding(key, value);
      }

      return {
        type: "vnode",
        name,
        props,
        children: children.flat(),
      };
    }
  },
  {
    fragment({ children }: { children: WorkerRenderNode[] }): WorkerVNode {
      return h(FRAGMENT_ELEMENT, null, ...children);
    },
  },
) as WorkerHFunction;

/**
 * Validate that a bidirectional binding ($prop) has a reactive value.
 *
 * @param key - The prop key (e.g., "$checked", "$value")
 * @param value - The prop value
 * @throws Error if the value is not a Cell or CellResult
 */
function validateBidirectionalBinding(key: string, value: unknown): void {
  // Value must be an object (Cell or CellResult)
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `Bidirectionally bound property ${key} is not reactive\n` +
        "If invoking from within computed(), consider moving the component into a pattern: E.g.\n" +
        "```\n" +
        (key === "$checked"
          ? "const Item = pattern<{ item: Item }>(({item}) => <div><ct-checkbox $checked={item.checked} />{item.title}</div>);"
          : "const Item = pattern<{ item: Item }>(({item}) => <div><ct-input $value={item.value} />{item.title}</div>);") +
        "\n```" +
        "\n" +
        "And then using it like `<Item {item} />`",
    );
  }

  // Must be a Cell or CellResult
  if (!isCell(value) && !isCellResult(value)) {
    throw new Error(
      `Bidirectionally bound property ${key} is not reactive\n` +
        "Use pattern parameter or create a cell using Writable.of()",
    );
  }
}

/**
 * Check if a value is event-handler-like (a function that handles events).
 */
export function isEventHandler(
  value: unknown,
): value is (event: unknown) => void {
  return typeof value === "function";
}

/**
 * Check if a prop key represents an event handler.
 */
export function isEventProp(key: string): boolean {
  return key.startsWith("on") && key.length > 2;
}

/**
 * Extract the event type from an event prop key.
 * E.g., "onClick" -> "click", "onMouseMove" -> "mousemove"
 */
export function getEventType(key: string): string {
  if (!key.startsWith("on")) {
    return key;
  }
  return key.slice(2).toLowerCase();
}

/**
 * Check if a prop key represents a bidirectional binding.
 */
export function isBindingProp(key: string): boolean {
  return key.startsWith("$");
}

/**
 * Get the actual prop name from a binding prop key.
 * E.g., "$value" -> "value", "$checked" -> "checked"
 */
export function getBindingPropName(key: string): string {
  if (!key.startsWith("$")) {
    return key;
  }
  return key.slice(1);
}

export default h;
