import { llm } from "@/utils/llm";
import { hydratePrompt, parseTagFromResponse } from "@/utils/prompt-library/prompting";

const SYSTEM_PROMPT = `
You are tasked with generating a concise, one-sentence description of a web application based on its specification, code, and schema. Your goal is to capture the essence of what the app does in a clear and informative manner.

Here are the inputs for the web application:

<spec>
{{SPEC}}
</spec>


<code>
{{CODE}}
</code>


<schema>
{{SCHEMA}}
</schema>

Carefully analyze the provided SPEC (text specification/description), CODE (React app), and SCHEMA (JSON schema) to understand the functionality and purpose of the web application.

Based on your analysis, generate a single sentence that accurately describes what the app does. The description should be concise yet informative, capturing the main functionality or purpose of the application.

Before generating the final output, use a <scratchpad> tag to outline your thoughts and plan the the final description. Consider the following questions:

- what is the functionality?
- what is the purpose?
- what is the user experience?

Provide your one-sentence description inside <description> tags.
`;

/**
 * Generates a single sentence description of a web application based on its specification, code, and schema.
 * @param spec - The specification/description of the web application.
 * @param code - The code of the web application.
 * @param schema - The schema of the web application.
 * @param model - The model to use to generate the description. (default: "anthropic:claude-3-5-sonnet-latest")
 * @returns The generated description.
 */
export async function describeCharm(
  spec: string,
  code: string,
  schema: string,
  model: string = "anthropic:claude-3-5-sonnet-latest",
) {
  const system = hydratePrompt(SYSTEM_PROMPT, { SPEC: spec, CODE: code, SCHEMA: schema });
  const prompt = `Describe the functionality of this app in a single sentence`;
  const response = await llm.sendRequest({
    model,
    system,
    stream: false,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  console.log("RESPONSE", parseTagFromResponse(response, "description"));
  return parseTagFromResponse(response, "description");
}
