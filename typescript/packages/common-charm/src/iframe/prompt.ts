import { JSONSchema } from "@commontools/builder";

async function loadRaw(filePath: string): Promise<string> {
  // Check if we’re running in Deno (which exposes a global Deno object)
  if (typeof Deno !== "undefined" && Deno.readTextFile) {
    // In Deno, read the file from disk using a URL relative to this module.
    return await Deno.readTextFile(new URL(filePath, import.meta.url));
  } else {
    // In Node/Vite, assume Vite’s raw loader is active.
    // Do a dynamic import with the `?raw` query.
    // (Vite will transform this import at build time.)
    const module = await import(filePath + "?raw");
    return module.default;
  }
}

const prefillHtml = await loadRaw("./prefill.html");
const systemMd = await loadRaw("./system.md");
import { LLMRequest } from "@commontools/llm-client";

const responsePrefill = "```html\n" + prefillHtml;

const SELECTED_MODEL = [
  // "groq:llama-3.3-70b-specdec",
  // "cerebras:llama-3.3-70b",
  // "anthropic:claude-3-5-sonnet-latest",
  "gemini-2.0-flash",
  // "gemini-2.0-flash-thinking",
  // "gemini-2.0-pro",
  // "o3-mini-low",
  // "o3-mini-medium",
  // "o3-mini-high",
];

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
  const messages = [];
  if (spec && src) {
    messages.push(spec);
    messages.push("```html\n" + src + "\n```");
  }

  messages.push(
    `The user asked you to ${spec ? "update" : "create"} the source code with the following comments:
\`\`\`
${newSpec}
\`\`\``,
  );
  messages.push(responsePrefill);

  const system = systemMd.replace("SCHEMA", JSON.stringify(schema, null, 2));

  return {
    model: model || SELECTED_MODEL,
    system,
    messages,
    stop: "\n```",
  };
};
