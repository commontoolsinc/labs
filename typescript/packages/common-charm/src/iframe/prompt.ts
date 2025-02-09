import { JSONSchema } from "@commontools/builder";

import demoSrc from "./demo.html?raw";
import prefillHtml from "./prefill.html?raw";
import systemMd from "./system.md?raw";
import { LLMRequest } from "@commontools/llm-client";

const responsePrefill = "```html\n" + prefillHtml;

const SELECTED_MODEL = [
    "groq:llama-3.3-70b-specdec",
    // "cerebras:llama-3.3-70b",
    "anthropic:claude-3-5-sonnet-latest",
  ];

export const buildPrompt = ({
    src,
    spec,
    newSpec,
    schema,
  }: {
    src?: string;
    spec?: string;
    newSpec: string;
    schema: JSONSchema;
  }): LLMRequest => {
    const messages = [];
    if (spec && src) {
      messages.push(spec);
      messages.push("```html\n" + src + "\n```");
    } else {
      messages.push("Make a simple counter that works with the following schema: { count: number }");
      messages.push("```html\n" + demoSrc + "\n```");
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
      model: SELECTED_MODEL,
      system,
      messages,
      stop: "\n```",
    };
  };
