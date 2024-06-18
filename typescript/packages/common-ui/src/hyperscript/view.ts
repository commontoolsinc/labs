import * as Schema from '../shared/schema.js';
import {
  AnyJSONObjectSchema,
  JSONSchemaRecord,
  bindable
} from './schema-helpers.js';
import {deepFreeze} from '../shared/deep-freeze.js';

export type Binding = {
  "@type": "binding";
  name: string;
}

/** Is value a binding to a reactive value? */
export const isBinding = (value: any): value is Binding => {
  return (
    value &&
    value["@type"] === "binding" &&
    typeof value.name === "string"
  );
}

/** Create a template binding */
export const binding = (name: string): Binding => ({
  "@type": "binding",
  name
});

/** A repeat binding repeats items in a dynamic list using a template */
export type RepeatBinding = {
  "@type": "repeat";
  name: string;
  template: VNode;
}

/** Is value a binding to a reactive value? */
export const isRepeatBinding = (value: any): value is RepeatBinding => {
  return (
    value != null &&
    value["@type"] === "repeat" &&
    typeof value.name === "string" &&
    isVNode(value.template)
  );
}

/** Create a template binding */
export const repeat = (
  name: string,
  template: VNode
): RepeatBinding => ({
  "@type": "repeat",
  name,
  template
});

export type Value = string | number | boolean | null | object;

export type ReactiveValue = Binding | Value;

export type Props = {
  [key: string]: ReactiveValue;
}

export type Tag = string;

export type Children = RepeatBinding | Binding | Array<VNode | string>;

export type VNode = {
  tag: Tag;
  props: Props;
  children: Children;
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

/** Internal helper for creating VNodes */
const vnode = (
  tag: string,
  props: Props = {},
  children: Children
): VNode  => ({
  tag,
  props,
  children
});

/** Is object a VNode? */
export const isVNode = (value: any): value is VNode => {
  return (
    value != null &&
    typeof value.tag === "string" &&
    typeof value.props === "object" &&
    value.children != null
  );
}

export type Factory = {
  (): VNode

  (props: Props): VNode

  (
    props: Props,
    children: Children
  ): VNode
};

export type PropsDescription = {
  schema: AnyJSONObjectSchema;
  validate: (data: any) => boolean;
}

export type View = Factory & {
  tag: Tag;
  props: PropsDescription;
};

/**
 * Create a tag factory that validates props against a schema.
 * @param tagName - HTML tag name
 * @param props - the properties section of a JSON schema
 */
export const view = (
  tagName: string,
  propertySchema: JSONSchemaRecord = {}
): View => {
  // Normalize tag name
  const tag = tagName.toLowerCase();

  const schema: AnyJSONObjectSchema = {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(propertySchema).map(([key, value]) => {
        return [key, bindable(value)]
      })
    )
  };

  // Compile props validator for fast validation at runtime.
  const validate = Schema.compile({
    ...schema,
    // Allow additional properties when validating props.
    additionalProperties: true
  });

  /**
   * Create a VNode for tag
   * Note: props are not validated. Validation happens later, during render.
   * @param props - properties for the tag
   * @param children - child nodes
   * @returns VNode
   */
  const create = (
    props: Props = {},
    children: Children = []
  ) => vnode(tag, props, children);

  create.tag = tag;
  create.props = {validate, schema};

  return deepFreeze(create);
};
