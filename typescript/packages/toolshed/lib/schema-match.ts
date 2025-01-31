import { Schema, Validator } from "jsonschema";

export function checkSchemaMatch(
  data: Record<string, unknown>,
  schema: Schema,
): boolean {
  try {
    const validator = new Validator();

    const jsonSchema: unknown = {
      type: "object",
      properties: Object.keys(schema).reduce(
        (acc: Record<string, unknown>, key) => {
          try {
            const schemaValue = schema[key as keyof Schema];
            acc[key] = {
              type: (schemaValue as any)?.type || typeof schemaValue,
            };
            return acc;
          } catch (err) {
            console.error(`Error reducing schema key ${key}:`, err);
            return acc;
          }
        },
        {},
      ),
      required: Object.keys(schema),
      additionalProperties: true,
    };

    try {
      const rootResult = validator.validate(data, jsonSchema as Schema);
      if (rootResult.valid) {
        return true;
      }
    } catch (err) {
      console.error("Error validating root schema:", err);
      return false;
    }

    function checkSubtrees(obj: unknown): boolean {
      try {
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
      } catch (err) {
        console.error("Error checking subtrees:", err);
        return false;
      }
    }

    return checkSubtrees(data);
  } catch (err) {
    console.error("Top level error in checkSchemaMatch:", err);
    return false;
  }
}
