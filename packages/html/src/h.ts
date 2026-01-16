import {
  type HFunction,
  type JSXElement,
  type RenderNode,
  type VNode,
} from "@commontools/api";
import { isCell, isCellResult } from "@commontools/runner";

/**
 * Fragment element name used for JSX fragments.
 */
const FRAGMENT_ELEMENT = "ct-fragment";

/**
 * JSX factory function for creating virtual DOM nodes.
 * @param name - The element name or component function
 * @param props - Element properties
 * @param children - Child elements
 * @returns A virtual DOM node or JSX element (for component functions)
 */
// Implementation uses broader types than overloads - assertion needed for TS compatibility
export const h: HFunction = Object.assign(
  function h(
    name: string | ((...args: any[]) => JSXElement),
    props: { [key: string]: any } | null,
    ...children: RenderNode[]
  ): JSXElement {
    if (typeof name === "function") {
      return name({
        ...(props ?? {}),
        children: children.flat(),
      });
    } else {
      props ??= {};
      Object.keys(props).filter((key) => key.startsWith("$")).forEach((key) => {
        const value = props![key];
        if (typeof value !== "object") {
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
        } else if (!isCell(value) && !isCellResult(value)) {
          throw new Error(
            `Bidirectionally bound property ${key} is not reactive\n` +
              "Use pattern parameter or create a cell using Writable.of()",
          );
        }
      });
      return { type: "vnode", name, props, children: children.flat() };
    }
  },
  {
    fragment({ children }: { children: RenderNode[] }): VNode {
      return h(FRAGMENT_ELEMENT, null, ...children);
    },
  },
) as HFunction;
