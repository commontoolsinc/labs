import { isQueryResultForDereferencing } from "@commontools/common-runner";
import { getCellReferenceOrThrow } from "@commontools/common-runner";
import { z } from "zod";

export function jsonSchemaToPlaceholder(schema: any): any {
  // Handle primitive types
  if (schema.type === "string") return "string";
  if (schema.type === "number" || schema.type === "integer") return 0;
  if (schema.type === "boolean") return false;
  if (schema.type === "null") return null;

  // Handle arrays
  if (schema.type === "array") {
    return [jsonSchemaToPlaceholder(schema.items)];
  }

  // Handle objects
  if (schema.type === "object") {
    const result: Record<string, any> = {};

    if (schema.properties) {
      for (const [key, value] of Object.entries(schema.properties)) {
        result[key] = jsonSchemaToPlaceholder(value);
      }
    }

    return result;
  }

  // Handle enums
  if (schema.enum) {
    return schema.enum[0];
  }

  // Handle const
  if (schema.const !== undefined) {
    return schema.const;
  }

  // Default fallback
  return undefined;
}

export function extractKeysFromJsonSchema(schema: any): string[] {
  // For primitive types, return empty array
  if (
    ["string", "number", "integer", "boolean", "null"].includes(schema.type)
  ) {
    return [];
  }

  // Handle arrays
  if (schema.type === "array") {
    return extractKeysFromJsonSchema(schema.items);
  }

  // Handle objects
  if (schema.type === "object") {
    const keys: string[] = [];

    if (schema.properties) {
      for (const [key, value] of Object.entries(schema.properties)) {
        // Add the current key
        keys.push(key);
        // Recursively get nested keys and prefix them with current key
        const nestedKeys = extractKeysFromJsonSchema(value).map(
          (k) => `${key}.${k}`,
        );
        keys.push(...nestedKeys);
      }
    }

    return keys;
  }

  return [];
}

export function zodSchemaToPlaceholder(schema: any): any {
  if (isQueryResultForDereferencing(schema)) {
    const ref = getCellReferenceOrThrow(schema);
    schema = ref.cell.getAtPath(ref.path);
  }

  // Handle primitive types
  if (schema._def.typeName === "ZodString") return "string";
  if (schema._def.typeName === "ZodNumber") return 0;
  if (schema._def.typeName === "ZodBoolean") return false;
  if (schema._def.typeName === "ZodDate") return new Date();
  if (schema._def.typeName === "ZodNull") return null;
  if (schema._def.typeName === "ZodUndefined") return undefined;

  // Handle arrays
  if (schema._def.typeName === "ZodArray") {
    return [zodSchemaToPlaceholder(schema._def.type)];
  }

  // Handle objects
  if (schema._def.typeName === "ZodObject") {
    const shape = schema._def.shape();
    const result: Record<string, any> = {};

    for (const [key, value] of Object.entries(shape)) {
      result[key] = zodSchemaToPlaceholder(value);
    }

    return result;
  }

  // Handle unions
  if (schema._def.typeName === "ZodUnion") {
    // Take the first option from the union
    return zodSchemaToPlaceholder(schema._def.options[0]);
  }

  // Handle optional
  if (schema._def.typeName === "ZodOptional") {
    return zodSchemaToPlaceholder(schema._def.innerType);
  }

  // Handle nullable
  if (schema._def.typeName === "ZodNullable") {
    return zodSchemaToPlaceholder(schema._def.innerType);
  }

  // Handle enums
  if (schema._def.typeName === "ZodEnum") {
    return schema._def.values[0];
  }

  // Handle literals
  if (schema._def.typeName === "ZodLiteral") {
    return schema._def.value;
  }

  // Default fallback
  return undefined;
}

export function extractKeysFromZodSchema(schema: z.ZodTypeAny): string[] {
  // For primitive types, return empty array as they don't have nested keys
  if (
    schema._def.typeName === "ZodString" ||
    schema._def.typeName === "ZodNumber" ||
    schema._def.typeName === "ZodBoolean" ||
    schema._def.typeName === "ZodDate" ||
    schema._def.typeName === "ZodNull" ||
    schema._def.typeName === "ZodUndefined" ||
    schema._def.typeName === "ZodEnum" ||
    schema._def.typeName === "ZodLiteral"
  ) {
    return [];
  }

  // Handle arrays
  if (schema._def.typeName === "ZodArray") {
    return extractKeysFromZodSchema(schema._def.type);
  }

  // Handle objects
  if (schema._def.typeName === "ZodObject") {
    const shape = schema._def.shape();
    const keys: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      // Add the current key
      keys.push(key);
      // Recursively get nested keys and prefix them with current key
      const nestedKeys = extractKeysFromZodSchema(value as any).map(
        (k) => `${key}.${k}`,
      );
      keys.push(...nestedKeys);
    }

    return keys;
  }

  // Handle unions
  if (schema._def.typeName === "ZodUnion") {
    // Get keys from first option
    return extractKeysFromZodSchema(schema._def.options[0]);
  }

  // Handle optional and nullable
  if (
    schema._def.typeName === "ZodOptional" ||
    schema._def.typeName === "ZodNullable"
  ) {
    return extractKeysFromZodSchema(schema._def.innerType);
  }

  return [];
}

export const jsonToDatalogQuery = (jsonObj: any) => {
  const select: Record<string, any> = {};
  const where: Array<any> = [];

  if (typeof jsonObj !== "object" || jsonObj === null)
    return { select: {}, where: [] };

  function processObject(root: string, obj: any, path: string, selectObj: any) {
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = path ? `${path}/${key}` : key;
      const varName = `?${currentPath}`.replace(/\//g, "_");

      if (Array.isArray(value)) {
        if (value[0] === null) {
          throw new Error("Cannot handle null values in arrays");
        }

        where.push({ Case: ["?item", key, `?${key}[]`] });
        where.push({ Case: [`?${key}[]`, `?[${key}]`, `?${key}`] });

        if (typeof value[0] === "object") {
          selectObj[key] = [{ ".": `?${key}` }];
          processObject(`?${key}`, value[0], currentPath, selectObj[key][0]);
          selectObj[`.${key}`] = `?${key}[]`;
        } else {
          selectObj[key] = [`?${key}`];
        }
      } else if (typeof value === "object" && value !== null) {
        selectObj[key] = {};
        processObject(root, value, currentPath, selectObj[key]);
      } else {
        selectObj[key] = varName;
        where.push({ Case: [root, key, varName] });
      }
    }
  }

  select["."] = "?item";
  processObject("?item", jsonObj, "", select);

  return {
    select,
    where,
  };
};

export function inferJsonSchema(data: unknown): any {
  // Handle null
  if (data === null) {
    return { type: "null" };
  }

  // Handle basic types
  switch (typeof data) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: Number.isInteger(data) ? "integer" : "number" };
    case "boolean":
      return { type: "boolean" };
    case "undefined":
      return {}; // JSON Schema doesn't have undefined type
  }

  // Handle arrays
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return {
        type: "array",
        items: {},
      };
    }
    // Infer schema from first element
    return {
      type: "array",
      items: inferJsonSchema(data[0]),
    };
  }

  // Handle objects
  if (typeof data === "object") {
    const properties: { [k: string]: any } = {};

    for (const [key, value] of Object.entries(data)) {
      properties[key] = inferJsonSchema(value);
    }

    return {
      type: "object",
      properties,
    };
  }

  // Fallback
  return {};
}

export function inferZodSchema(data: unknown): z.ZodTypeAny {
  // Handle null
  if (data === null) {
    return z.null();
  }

  // Handle basic types
  switch (typeof data) {
    case "string":
      return z.string();
    case "number":
      return Number.isInteger(data) ? z.number().int() : z.number();
    case "boolean":
      return z.boolean();
    case "undefined":
      return z.undefined();
  }

  // Handle arrays
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return z.array(z.unknown());
    }
    // Infer schema from first element
    return z.array(inferZodSchema(data[0]));
  }

  // Handle objects
  if (typeof data === "object") {
    const shape: { [k: string]: z.ZodTypeAny } = {};

    for (const [key, value] of Object.entries(data)) {
      shape[key] = inferZodSchema(value);
    }

    return z.object(shape);
  }

  // Fallback
  return z.unknown();
}

export function generateZodCode(schema: any, indent: number = 0): string {
  // Handle null
  if (schema.type === "null") {
    return "z.null()";
  }

  let zodSchema = "";
  const spacing = "  ".repeat(indent);
  const innerSpacing = "  ".repeat(indent + 1);

  // Handle basic types
  switch (schema.type) {
    case "string":
      zodSchema = "z.string()";
      break;
    case "number":
      zodSchema = "z.number()";
      break;
    case "integer":
      zodSchema = "z.number().int()";
      break;
    case "boolean":
      zodSchema = "z.boolean()";
      break;
    default:
      // Handle arrays
      if (schema.type === "array") {
        const itemsSchema = schema.items
          ? generateZodCode(schema.items, indent)
          : "z.any()";
        zodSchema = `z.array(${itemsSchema})`;
      }
      // Handle objects
      else if (schema.type === "object") {
        const properties = schema.properties || {};
        const zodProperties = Object.entries(properties)
          .map(
            ([key, value]) =>
              `${innerSpacing}${key}: ${generateZodCode(value, indent + 1)}`,
          )
          .join(",\n");
        zodSchema = `z.object({\n${zodProperties}\n${spacing}})`;
      }
      // Fallback to any
      else {
        zodSchema = "z.any()";
      }
  }

  // Add description if present
  if (schema.description) {
    zodSchema += `.describe(${JSON.stringify(schema.description)})`;
  }

  // Add default if present
  if (schema.default !== undefined) {
    zodSchema += `.default(${JSON.stringify(schema.default)})`;
  }

  return zodSchema;
}

export const generateZodSpell = (schema: any): string => {
  const zodCode = generateZodCode(schema);

  return `import { h } from "@commontools/common-html";
import {
  recipe,
  lift,
  llm,
  handler,
  navigateTo,
  NAME,
  UI,
  ifElse
} from "@commontools/common-builder";
import { z } from "zod"; 
import { zodToJsonSchema } from "zod-to-json-schema";

const stringify = lift((state) => JSON.stringify(state, null, 2));
const imageUrl = lift((prompt) => '/api/img?prompt=' + encodeURIComponent(prompt));

const Schema = ${zodCode};
//PREFILL

export default recipe(Schema, (state) => {
  return {
    [NAME]: ${JSON.stringify(schema.description)},
    [UI]: <os-container>
      <h2>Data</h2>
      <pre>{stringify(state)}</pre>
    </os-container>
  }
});
`;
};

// const zodSchemaCode = generateZodCode(inferredSchema);
// console.log(zodSchemaCode);
