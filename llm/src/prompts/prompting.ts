export type LlmPrompt = {
  version: string;
  text: string;
};

function hash(source: string): string {
  // Create a simple hash function that doesn't require async/await
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }

  // Convert to hex string and ensure it's positive
  const hashHex = (hash >>> 0).toString(16).padStart(8, "0");

  // Make it look more like a SHA hash with more characters
  return hashHex;
}

export function llmPrompt(id: string, text: string): LlmPrompt {
  return { version: `${id}@${hash(text)}`, text };
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
      : context[key]?.text || match;
  });

  const dependencies: string[] = [prompt.version];
  // Add all context values used in the prompt as dependencies
  for (const key in context) {
    const value = context[key];
    if (typeof value != "string") {
      dependencies.push(value.version);
    }
  }

  return {
    version: dependencies.join("+"),
    text,
  };
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
