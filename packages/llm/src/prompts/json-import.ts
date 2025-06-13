/**
 * Helper function to format JSON data for inclusion in a prompt
 *
 * @param title The title for the imported data
 * @param jsonData The JSON data to import
 * @returns A formatted prompt string for the import-json workflow
 */

import { createJsonSchema } from "@commontools/runner";

export function formatJsonImportPrompt(title: string, jsonData: any): string {
  const schema = createJsonSchema(jsonData);
  const schemaString = JSON.stringify(schema, null, 2);
  return `${title}\n\nLook at the attached JSON schema and use it to create a new charm.\n\n${schemaString}`;
}
