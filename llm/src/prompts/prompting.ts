export type LlmPrompt = {
  version: string;
  text: string;
  dependencies?: Record<string, LlmPrompt | string>;
};

async function sha256(source: string) {
  const sourceBytes = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest("SHA-256", sourceBytes);
  const resultBytes = [...new Uint8Array(digest)];
  return resultBytes.map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function llmPrompt(id: string, text: string): LlmPrompt {
  const hash = sha256(text);

  return { version: `${id}@${hash}`, text };
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

  const dependencies = prompt.dependencies || {};
  // Add all context values used in the prompt as dependencies
  for (const key in context) {
    const value = context[key];
    dependencies[key] = value;
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
