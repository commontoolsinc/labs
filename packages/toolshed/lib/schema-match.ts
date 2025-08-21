import { Schema, Validator } from "jsonschema";
import { isRecord } from "@commontools/utils/types";

function checkSubtrees(
  obj: unknown,
  validator: Validator,
  jsonSchema: Schema,
): boolean {
  try {
    if (typeof obj !== "object" || obj === null) {
      return false;
    }

    if (Array.isArray(obj)) {
      return obj.some((item) => checkSubtrees(item, validator, jsonSchema));
    }

    const result = validator.validate(obj, jsonSchema);
    if (result.valid) {
      return true;
    }

    return Object.values(obj).some((value) =>
      checkSubtrees(value, validator, jsonSchema)
    );
  } catch (err) {
    console.error("Error checking subtrees:", err);
    return false;
  }
}

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
            const schemaValue = schema[key as keyof Schema] as unknown;
            acc[key] = {
              type: (isRecord(schemaValue) && schemaValue.type) ||
                typeof schemaValue,
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

    return checkSubtrees(data, validator, jsonSchema as Schema);
  } catch (err) {
    console.error("Top level error in checkSchemaMatch:", err);
    return false;
  }
}
