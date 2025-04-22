/**
 * Helper function to format JSON data for inclusion in a prompt
 *
 * @param title The title for the imported data
 * @param jsonData The JSON data to import
 * @returns A formatted prompt string for the import-json workflow
 */

// FIXME(ja): do we really want to send all the json data to the LLM?
export function formatJsonImportPrompt(title: string, jsonData: any): string {
  const jsonString = JSON.stringify(jsonData, null, 2);
  return `${title}\n\nLook at the attached JSON data and use it to create a new charm.\n\n${jsonString}`;
}
