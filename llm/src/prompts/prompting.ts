export type LlmPrompt = {
  version: string;
  text: string;
  dependencies?: LlmPrompt[];
};

export function llmPrompt(version: string, text: string): LlmPrompt {
  return { version, text };
}

/**
 * Hydrates a prompt template from a context object of key-value pairs.
 * @param prompt - The prompt template, with `{{ EXAMPLE }}` placeholders.
 * @param context - The context to hydrate the prompt with.
 * @returns The hydrated prompt string
 */
export function hydratePrompt(
  prompt: LlmPrompt,
  context: Record<string, string | LlmPrompt>,
): LlmPrompt {
  const text = prompt.text.replace(/\{\{\s*([^}]+)\s*\}\}/g, (match, p1) => {
    const key = p1.trim();
    return typeof context[key] === "string"
      ? context[key] || match
      : context[key].text || match;
  });

  const dependencies = prompt.dependencies || [];
  // Add all context items that are LlmPrompts as dependencies
  for (const key in context) {
    if (typeof context[key] !== "string" && "version" in context[key]) {
      dependencies.push(context[key] as LlmPrompt);
    }
  }

  return { version: prompt.version, text, dependencies };
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
): string {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`<${escapedTag}>([\\s\\S]*?)</${escapedTag}>`);
  const match = response.trim().match(regex);
  if (match && match[1]) {
    return match[1].trim();
  }
  throw new Error(`Tag ${tag} not found in response`);
}
