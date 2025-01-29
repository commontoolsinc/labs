import { Validator } from "@cfworker/json-schema";

/** Validate a schema at runtime */
export const validate = (schema: object, data: any) => {
  const validator = new Validator(schema);
  return validator.validate(data);
};

/**
 * Compile a static schema for fast validataion
 * @returns a function that validates data
 */
export const compile = (schema: object) => {
  const validator = new Validator(schema);
  return (data: any): boolean => {
    const { valid } = validator.validate(data);
    return valid;
  };
};
