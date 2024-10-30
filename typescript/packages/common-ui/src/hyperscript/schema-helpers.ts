/** Schema helpers */

export type AnyJSONSchema = object;

export type JSONSchemaRecord = Record<string, AnyJSONSchema>;

export type AnyJSONObjectSchema = {
  type: "object";
  properties: Record<string, AnyJSONSchema>;
  additionalProperties?: boolean;
};

export const t = (type: string) => ({ type });

// NOTE: these are written as factories for JSONSchema objects, rather than
// frozen schema objects because the JSONSchema validator mutates the object
// to add metadata about the schema.

/** JSONSchema for binding */
export const binding = () => ({
  type: "object",
  properties: {
    "@type": { type: "string" },
    name: { type: "string" },
  },
  required: ["@type", "name"],
});

export const bindable = (schema: AnyJSONSchema) => ({
  anyOf: [schema, binding()],
});

/** Mixin for list of allowed basic events */
export const eventProps = () => ({
  // Basic events
  "@click": binding(),
  "@change": binding(),
  "@focus": binding(),
  "@blur": binding(),
  "@focusin": binding(),
  "@focusout": binding(),
  "@input": binding(),
  "@keydown": binding(),
  "@keyup": binding(),
  "@mousedown": binding(),
  "@mouseenter": binding(),
  "@mouseleave": binding(),
  "@mousemove": binding(),
  "@mouseout": binding(),
  "@mouseover": binding(),
  "@mouseup": binding(),

  // Custom events
  "@messageSend": binding(),
  "@todo-checked": binding(),
  "@todo-input": binding(),
  "@select-suggestion": binding(),
  "@common-input": binding(),
});

export const basicProps = () => ({
  ...eventProps(),
  accesskey: { type: "string" },
  autocapitalize: { type: "string" },
  class: { type: "string" },
  disabled: { type: "boolean" },
  id: { type: "string" },
  name: { type: "string" },
  role: { type: "string" },
  spellcheck: { type: "boolean" },
  slot: { type: "string" },
  title: { type: "string" },
});
