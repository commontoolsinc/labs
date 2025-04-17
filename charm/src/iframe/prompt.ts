import { JSONSchema } from "@commontools/builder";
import { hydratePrompt, type LLMRequest } from "@commontools/llm";

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

export const buildPrompt = ({
  src,
  spec,
  newSpec,
  schema,
  steps,
  model,
  cache = true,
}: {
  src?: string;
  spec?: string;
  newSpec: string;
  schema: JSONSchema;
  steps?: string[];
  model?: string;
  cache: boolean;
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
\`\`\`${
      steps && steps.length
        ? `

by following the following steps:
${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`
        : ""
    }`,
  );

  messages.push(RESPONSE_PREFILL);

  const system = hydratePrompt(systemMd, {
    SCHEMA: JSON.stringify(schema, null, 2),
  });

  return {
    model: model || SELECTED_MODEL,
    system: system.text,
    messages,
    stop: "\n```",
    metadata: {
      systemPrompt: system.version,
    },
    cache,
  };
};
