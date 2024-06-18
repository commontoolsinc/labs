import * as Schema from '../shared/schema.js';
import deepFreeze from '../shared/deep-freeze.js';

export type AnyJSONSchema = object;

export type JSONSchemaRecord = Record<string, AnyJSONSchema>;

export type AnyJSONObjectSchema = {
  type: "object";
  properties: Record<string, AnyJSONSchema>;
  additionalProperties?: boolean;
};

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
    value &&
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

export type VNode = {
  tag: Tag;
  props: Props;
  children: RepeatBinding | Array<VNode | string>;
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
export const isVNode = Schema.compile(VNodeSchema)

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
  properties: JSONSchemaRecord = {}
): View => {
  // Normalize tag name
  const tag = tagName.toLowerCase();

  const schema: AnyJSONObjectSchema = {
    type: "object",
    properties
  };

  // Compile props validator for fast validation at runtime.
  const validate = Schema.compile({
    ...schema,
    // Allow additional properties when validating props.
    additionalProperties: true
  });

  /** Create an element from a view, validating props  */
  const create = (
    props: Props = {},
    ...children: Array<VNode | string>
  ) => {
    if (!validate(props)) {
      throw new TypeError(`Invalid props for ${tag}.
        Props: ${JSON.stringify(props)}
        Schema: ${JSON.stringify(schema)}`);
    }
    return vh(tag, props, ...children);
  }

  create.tag = tag;
  create.props = {validate, schema};

  return deepFreeze(create);
};
