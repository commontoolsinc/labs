/**
 * JSON-compatible wire format value. This is the intermediate tree
 * representation used during serialization tree walking -- NOT the final
 * serialized form (which is `string`). Internal to the JSON implementation.
 */
export type JsonWireValue =
  | null
  | boolean
  | number
  | string
  | JsonWireValue[]
  | { [key: string]: JsonWireValue };

/**
 * Alias for `JsonWireValue` used throughout serialization internals
 * (tree-walking functions, type handlers). Named `SerializedForm` for
 * historical reasons; represents the intermediate wire format, not the
 * final boundary type.
 */
export type SerializedForm = JsonWireValue;
