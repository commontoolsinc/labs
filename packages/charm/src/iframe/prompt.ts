import { JSONSchema } from "@commontools/runner";
import {
  applyDefaults,
  type GenerationOptions,
  hydratePrompt,
  type LLMRequest,
} from "@commontools/llm";
import { type BuiltInLLMMessage } from "@commontools/api";
import { extractUserCode, staticSystemMd } from "./static.ts";
import { type StaticCache } from "@commontools/static";

export const RESPONSE_PREFILL = "```javascript\n";

export const buildPrompt = async ({
  src,
  spec,
  newSpec,
  schema,
  steps,
  staticCache,
}: {
  src?: string;
  spec?: string;
  newSpec: string;
  schema: JSONSchema;
  steps?: string[];
  staticCache: StaticCache;
}, options: GenerationOptions): Promise<LLMRequest> => {
  const { model, cache, space, generationId } = applyDefaults(options);

  const messages: BuiltInLLMMessage[] = [];
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

  const systemPrompt = await staticSystemMd(staticCache);
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
