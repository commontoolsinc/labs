/**
 * Subset of JSON Schema definitions.
 *
 * TBD whether we should just go full JSON schema with a library instead.
 */

type uri = string;

// String schema definition
type StringSchema = {
  type: "string";
  minLength?: number;
  maxLength?: number;
  pattern?: string;
};

// Number schema definition
type NumberSchema = {
  type: "number";
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
};

// Boolean schema definition
type BooleanSchema = {
  type: "boolean";
};

// Array schema definition
type ArraySchema = {
  type: "array";
  items: Schema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
};

// Object schema definition
type ObjectSchema = {
  type: "object";
  properties: {
    [key: string]: Schema;
  };
  required?: string[];
  additionalProperties?: boolean | Schema;
};

// Null schema definition
type NullSchema = {
  type: "null";
};

// Combined schema type
export type Schema =
  | StringSchema
  | NumberSchema
  | BooleanSchema
  | ArraySchema
  | ObjectSchema
  | NullSchema;
