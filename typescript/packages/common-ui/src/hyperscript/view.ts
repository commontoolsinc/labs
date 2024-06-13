import * as schema from '../schema.js';

export type AnyJSONSchema = object;

export type Binding = {
  "@type": "binding";
  name: string;
}

/** Is value a binding to a reactive value? */
export const isBinding = (value: any): value is Binding => {
  return (
    value &&
    value["@type"] === "binding" &&
    typeof value.name === "string" &&
    typeof value.name === "string"
  );
}

/** Create a template binding */
export const binding = (name: string): Binding => ({
  "@type": "binding",
  name
});

export type Value = string | number | boolean | null | object;

export type ReactiveValue = Binding | Value;

export type Props = {
  [key: string]: ReactiveValue;
}

export type Tag = string;

export type VNode = {
  tag: Tag;
  props: Props;
  children: Array<VNode | string>;
}

// NOTE: don't freeze this object, since the validator will want to mutate it.
export const VNodeSchema = {
  $id: "https://common.tools/schema/vnode.json",
  title: "VNode",
  description: "View Node",
  type: "object",
  properties: {
    tag: { type: "string" },
    props: {
      type: "object",
      additionalProperties: {
        oneOf: [
          { type: "string" },
          { type: "number" },
          { type: "boolean" },
          { type: "null" },
          { type: "object" },
          { type: "array" },
          { type: "signal" }
        ]
      }
    },
    children: {
      type: "array",
      items: {
        oneOf: [
          { type: "string" },
          { $ref: "#" }
        ]
      }
    }
  },
  required: ["tag", "props", "children"]
}

/** Is object a VNode? */
export const isVNode = schema.compile(VNodeSchema)

/** Internal helper for creating VNodes */
const vh = (
  tag: string,
  props: Props = {},
  ...children: Array<VNode | string>
): VNode  => ({
  tag,
  props,
  children
});

export type Factory = {
  (): VNode

  (
    props: Props,
    ...children: Array<VNode | string>
  ): VNode
};

export type View = Factory & {
  tag: Tag;
  validateProps: (data: any) => boolean;
}

/**
 * Create a tag factory that validates props against a schema.
 * @param tagName - HTML tag name
 * @param propsSchema - JSON schema for props
 */
export const view = (
  tagName: string,
  propsSchema: AnyJSONSchema = {}
): View => {
  // Normalize tag name
  const tag = tagName.toLowerCase();
  // Compile props validator for fast validation at runtime.
  const validateProps = schema.compile(propsSchema);

  /** Create an element from a view, validating props  */
  const create = (
    props: Props = {},
    ...children: Array<VNode | string>
  ) => {
    if (!validateProps(props)) {
      throw new TypeError(`Invalid props for ${tag}`);
    }
    return vh(tag, props, ...children);
  }

  create.tag = tag;
  create.validateProps = validateProps;

  return Object.freeze(create);
};
