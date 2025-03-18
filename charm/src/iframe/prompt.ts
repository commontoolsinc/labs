import { JSONSchema } from "@commontools/builder";
import { type LLMRequest } from "@commontools/llm";

import { extractUserCode, systemMd } from "./static.ts";

export const RESPONSE_PREFILL = "```javascript\n";

const SELECTED_MODEL = [
  // "groq:llama-3.3-70b-specdec",
  // "cerebras:llama-3.3-70b",
  // "anthropic:claude-3-5-sonnet-latest",
  "anthropic:claude-3-7-sonnet-latest",
  // "gemini-2.0-flash",
  // "gemini-2.0-flash-thinking",
  // "gemini-2.0-pro",
  // "o3-mini-low",
  // "o3-mini-medium",
  // "o3-mini-high",
];

function printSchema(schema: JSONSchema): string {
  const interfaces: string[] = [];
  const interfaceNames: Map<string, string> = new Map();
  let rootInterfaceName = "ViewModel";

  // Generate a TypeScript-like interface name from a path or title
  function generateInterfaceName(path: string, title?: string): string {
    if (title && title !== "root") return title;
    const cleanPath = path.replace(/\//g, ".");
    const parts = cleanPath.split(".");
    const lastPart = parts[parts.length - 1];
    if (!lastPart) return "Interface";
    return lastPart.charAt(0).toUpperCase() + lastPart.slice(1);
  }

  // Convert a JSON schema type to TypeScript type
  function getTypeString(propSchema: JSONSchema, path: string): string {
    if (!propSchema) return "any";

    if (propSchema.enum) {
      return propSchema.enum.map((v) => JSON.stringify(v)).join(" | ");
    }

    if (propSchema.type === "array" && propSchema.items) {
      const itemType = propSchema.items.type === "object"
        ? processObjectSchema(propSchema.items, `${path}/items`)
        : getTypeString(propSchema.items, `${path}/items`);
      return `${itemType}[]`;
    }

    if (propSchema.type === "object") {
      return processObjectSchema(propSchema, path);
    }

    switch (propSchema.type) {
      case "string":
        return "string";
      case "number":
        return "number";
      case "integer":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      default:
        return "any";
    }
  }

  // Process an object schema and return its interface name
  function processObjectSchema(objSchema: JSONSchema, path: string): string {
    if (interfaceNames.has(path)) {
      return interfaceNames.get(path)!;
    }

    const interfaceName = generateInterfaceName(path, objSchema.title);
    interfaceNames.set(path, interfaceName);

    const props: string[] = [];
    if (objSchema.properties) {
      for (
        const [propName, propSchema] of Object.entries(objSchema.properties)
      ) {
        const propPath = `${path}/${propName}`;
        const propType = getTypeString(propSchema as JSONSchema, propPath);
        let propString = `  ${propName}: ${propType};`;

        // Add default value as comment if it exists
        if ((propSchema as JSONSchema).default !== undefined) {
          propString += ` // default: ${
            JSON.stringify((propSchema as JSONSchema).default)
          }`;
        }

        props.push(propString);
      }
    }

    interfaces.push(`interface ${interfaceName} {\n${props.join("\n")}\n}`);
    return interfaceName;
  }

  // Start processing from the root
  rootInterfaceName = processObjectSchema(schema, "root");

  // If the root schema has no properties, create an empty interface
  if (interfaces.length === 0) {
    interfaces.push(`interface ${rootInterfaceName} {\n  // Empty schema\n}`);
  }

  // Move the root interface to the top
  const rootInterfaceIndex = interfaces.findIndex((i) =>
    i.startsWith(`interface ${rootInterfaceName}`)
  );
  if (rootInterfaceIndex > 0) {
    const rootInterface = interfaces.splice(rootInterfaceIndex, 1)[0];
    interfaces.unshift(rootInterface);
  }

  debugger;
  return interfaces.join("\n\n");
}

export const buildPrompt = ({
  src,
  spec,
  newSpec,
  schema,
  model,
}: {
  src?: string;
  spec?: string;
  newSpec: string;
  schema: JSONSchema;
  model?: string;
}): LLMRequest => {
  const messages: string[] = [];
  if (spec && src) {
    messages.push(spec);
    const extractedCode = extractUserCode(src);
    if (extractedCode !== null) {
      messages.push("```javascript\n" + extractedCode + "\n```");
    } else {
      messages.push("```html\n" + src + "\n```");
    }
  }

  messages.push(
    `The user asked you to ${
      spec ? "update" : "create"
    } the source code with the following specification:
\`\`\`
${newSpec}
\`\`\``,
  );

  messages.push(RESPONSE_PREFILL);

  const system = systemMd.replace("SCHEMA", printSchema(schema));

  return {
    model: model || SELECTED_MODEL,
    system,
    messages,
    stop: "\n```",
  };
};
