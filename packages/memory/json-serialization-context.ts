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
