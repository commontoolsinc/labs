import { llmPrompt } from "./prompting.ts";

/**
 * Helper function to format JSON data for inclusion in a prompt
 *
 * @param title The title for the imported data
 * @param jsonData The JSON data to import
 * @returns A formatted prompt string for the import-json workflow
 */
export function formatJsonImportPrompt(title: string, jsonData: any): string {
  const jsonString = JSON.stringify(jsonData, null, 2);
  return `${title}\n\nLook at the attached JSON data and use it to create a new charm.\n\n${jsonString}`;
}

// Define a system prompt for JSON import
export const JSON_IMPORT_SYSTEM_PROMPT = llmPrompt(
  "json-import-system",
  `
You are an expert in analyzing JSON data structures and creating effective visualizations for them.
Your task is to examine the provided JSON data and create a charm that best represents and interacts with this data.

Follow these guidelines:
1. Analyze the JSON structure to identify key entities, attributes, and relationships
2. Design an appropriate visualization that showcases the data effectively
3. Create intuitive interactions for exploring and manipulating the data
4. Handle both simple and complex nested data structures appropriately
5. Consider the user's needs when working with this specific type of data
`,
);

// Define a user prompt template for JSON import
export const JSON_IMPORT_USER_PROMPT = llmPrompt(
  "json-import-user",
  `{{JSON_IMPORT_PROMPT}}`,
);
