import { JSONSchema } from "@commontools/builder";
import {
  applyDefaults,
  type GenerationOptions,
  hydratePrompt,
  type LLMMessage,
  type LLMRequest,
} from "@commontools/llm";
import { extractUserCode, staticSystemMd } from "./static.ts";

export const RESPONSE_PREFILL = "```javascript\n";

export const buildPrompt = async ({
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
}, options: GenerationOptions): Promise<LLMRequest> => {
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
<steps>
${steps.map((step, index) => `<step>${step}</step>`).join("\n")}
</steps>`
        : ""
    }`,
  });

  messages.push({
    role: "assistant",
    content: RESPONSE_PREFILL,
  });

  const systemPrompt = await staticSystemMd();
  const system = hydratePrompt(systemPrompt, {
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
