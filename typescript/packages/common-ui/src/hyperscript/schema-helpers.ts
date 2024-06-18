/** Schema helpers */

export type AnyJSONSchema = object;

export type JSONSchemaRecord = Record<string, AnyJSONSchema>;

export type AnyJSONObjectSchema = {
  type: "object";
  properties: Record<string, AnyJSONSchema>;
  additionalProperties?: boolean;
};

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
});
