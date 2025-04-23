import { JSONSchema } from "@commontools/builder";
import {
  DEFAULT_MODEL_NAME,
  hydratePrompt,
  type LLMMessage,
  type LLMRequest,
} from "@commontools/llm";

import { extractUserCode, systemMd } from "./static.ts";
import { applyDefaults, GenerationOptions } from "../../../llm/src/options.ts";

export const RESPONSE_PREFILL = "```javascript\n";

export const buildPrompt = ({
  src,
  spec,
  newSpec,
  schema,
  steps,
}: {
  src?: string;
  spec?: string;
  newSpec: string;
  schema: JSONSchema;
  steps?: string[];
}, options: GenerationOptions): LLMRequest => {
  const { model, cache, space, generationId } = applyDefaults(options);

  const messages: LLMMessage[] = [];
  if (spec && src) {
    messages.push({
      role: "user",
      content: spec,
    });
    const extractedCode = extractUserCode(src);
    if (extractedCode !== null) {
      messages.push({
        role: "assistant",
        content: "```javascript\n" + extractedCode + "\n```",
      });
    } else {
      messages.push({
        role: "assistant",
        content: "```html\n" + src + "\n```",
      });
    }
  }

  messages.push({
    role: "user",
    content: `The user asked you to ${
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
  });

  messages.push({
    role: "assistant",
    content: RESPONSE_PREFILL,
  });

  const system = hydratePrompt(systemMd, {
    SCHEMA: JSON.stringify(schema, null, 2),
  });

  return {
    model: model,
    system: system.text,
    messages,
    stop: "\n```",
    metadata: {
      systemPrompt: system.version,
      generationId,
      space,
    },
    cache,
  };
};
