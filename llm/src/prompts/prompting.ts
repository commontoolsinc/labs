/**
 * Hydrates a prompt template from a context object of key-value pairs.
 * @param prompt - The prompt template, with `{{ EXAMPLE }}` placeholders.
 * @param context - The context to hydrate the prompt with.
 * @returns The hydrated prompt string
 */
export function hydratePrompt(prompt: string, context: any): string {
  return prompt.replace(/\{\{\s*([^}]+)\s*\}\}/g, (match, p1) => {
    const key = p1.trim();
    return context[key] || match;
  });
}

/**
 * Parses an xml tag from a response.
 * @param response - The response to parse.
 * @param tag - The tag to parse.
 * @returns The content within the given tag, or null if the tag is not found.
 */
// NOTE(jake): To parse content in <foo> tags, call with:
// `await parseTagFromResponse(response, "foo")`
export function parseTagFromResponse(
  response: string,
  tag: string,
): string | null {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`<${escapedTag}>([\\s\\S]*?)</${escapedTag}>`);
  const match = response.trim().match(regex);
  if (match && match[1]) {
    return match[1].trim();
  }
  return null;
}
