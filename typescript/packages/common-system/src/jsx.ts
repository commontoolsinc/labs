import {
  node,
  attribute,
  property,
  text,
  Node,
  EncodedEvent,
  Attribute,
  on as handler,
} from "@gozala/co-dom";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: any;
    }
  }
}

export const Fragment = "Fragment";

export const on = (
  event: EncodedEvent["type"],
  attribute: string = `~/on/${event}`,
) =>
  handler(event, {
    decode(event: EncodedEvent) {
      return {
        message: /** @type {DB.Fact} */ [
          attribute,
          /** @type {any & DB.Entity} */ event,
        ],
      };
    },
  });

const setting = <T>(key: string, value: unknown): Attribute<T> => {
  if (key === "class") {
    if (Array.isArray(value)) {
      return attribute("class", [...new Set(value)].sort().join(" "));
    } else {
      return attribute("class", String(value));
    }
  }

  if (key.startsWith("data-")) {
    return attribute(key, String(value));
  }

  if (key.startsWith("on")) {
    return on(key.slice(2), value as any) as Attribute<T>;
  }

  return property(key, value);
};

const toChild = <T>(child: unknown): Node<T> => {
  switch (typeof child) {
    case "string":
      return text(child);
    case "number":
      return text(String(child));
    case "boolean":
      return text(String(child));
    default:
      return child === null ? text(String(null)) : (child as Node<T>);
  }
};

export const h = <T>(
  localName: string,
  settings: { [key: string]: any } | null,
  ...children: Node<T>[]
): Node<T> =>
  node(
    localName,
    Object.entries(settings ?? {}).map(([key, value]) => setting(key, value)),
    children.map(toChild),
  ) as Node<T>;
