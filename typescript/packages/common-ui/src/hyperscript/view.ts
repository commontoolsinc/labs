import * as schema from '../schema.js';

export type AnyJSONSchema = object;

export type SignalBinding = {
  "@type": "signal";
  type: AnyJSONSchema;
  name: string;
}

/** Is value a binding to a reactive value? */
export const isSignalBinding = (value: any): value is SignalBinding => {
  return (
    value &&
    value["@type"] === "signal" &&
    typeof value.name === "string" &&
    typeof value.name === "string"
  );
}

/** Create a signal binding */
export const signal = (type: AnyJSONSchema, name: string): SignalBinding => ({
  "@type": "signal",
  type,
  name
});

export type Value = string | number | boolean | null | object;

export type ReactiveValue = SignalBinding | Value;

export type Props = {
  [key: string]: ReactiveValue;
}

export type Tag = string;

export type VNode = {
  tag: Tag;
  props: Props;
  children: Array<VNode | string>;
}

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

export type Factory = (
  props: Props,
  ...children: Array<VNode | string>
) => VNode;

export type View = Factory & {
  tag: Tag;
  validateProps: (data: any) => boolean;
}

/**
 * Create a tag factory that validates props against a schema.
 * @param tagName - HTML tag name
 * @param props - JSON schema for props
 */
export const view = (
  tagName: string,
  props: AnyJSONSchema
): View => {
  // Normalize tag name
  const tag = tagName.toLowerCase();
  // Compile props validator for fast validation at runtime.
  const validateProps = schema.compile(props);

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
