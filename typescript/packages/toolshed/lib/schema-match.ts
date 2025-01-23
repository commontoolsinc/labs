import { Schema, Validator } from "jsonschema";

export function checkSchemaMatch(
  data: Record<string, unknown>,
  schema: Schema,
): boolean {
  const validator = new Validator();

  const jsonSchema: unknown = {
    type: "object",
    properties: Object.keys(schema).reduce(
      (acc: Record<string, unknown>, key) => {
        const schemaValue = schema[key as keyof Schema];
        acc[key] = { type: (schemaValue as any)?.type || typeof schemaValue };
        return acc;
      },
      {},
    ),
    required: Object.keys(schema),
    additionalProperties: true,
  };

  const rootResult = validator.validate(data, jsonSchema as Schema);
  if (rootResult.valid) {
    return true;
  }

  function checkSubtrees(obj: unknown): boolean {
    if (typeof obj !== "object" || obj === null) {
      return false;
    }

    if (Array.isArray(obj)) {
      return obj.some((item) => checkSubtrees(item));
    }

    const result = validator.validate(obj, jsonSchema as Schema);
    if (result.valid) {
      return true;
    }

    return Object.values(obj).some((value) => checkSubtrees(value));
  }

  return checkSubtrees(data);
}
