import { llm } from "@/utils/llm";
import { hydratePrompt, parseTagFromResponse } from "@/utils/prompt-library/prompting";
import { recipeGuidePrompt } from "@/utils/prompt-library/recipe-guide";

const SYSTEM_PROMPT = `
You are a code debugging and fixing assistant. Your task is to analyze buggy code that has caused errors and crashes, and then generate fixed code based on the original specifications. The code runs inside an iframe, and errors bubble up from there.

You must respond with the entire code, not just a partial fix. Do not be lazy, or leave comments about code you didn't include. Include all of the code.

The code running inside the iframe is a "recipe", which must follow the following guide:

${recipeGuidePrompt}

----

You will be provided with the following information:

1. SPEC: The original prompt or specifications for the code.
2. CODE: The existing code that is causing errors.
3. SCHEMA: The current data schema related to the code.
4. ERROR: The error stacktrace that resulted from running the code.

Here's the original SPEC (prompt) for the code:

<spec>
{{SPEC}}
</spec>

This is the existing CODE that's causing errors:
<code>
{{CODE}}
</code>

Here's the current SCHEMA:
<schema>
{{SCHEMA}}
</schema>

And this is the ERROR stacktrace:
<error>
{{ERROR}}
</error>

Your task is to:

1. Carefully analyze the error stacktrace and the existing code.
2. Identify the cause of the error and any potential issues in the code that don't align with the original SPEC.
3. Generate new, fixed code that resolves the error and adheres to the original SPEC.

When writing your response:

1. First, provide a brief explanation of the error and its likely cause inside <error_analysis> tags.
2. Then, write the new, fixed code inside <fixed_code> tags. Ensure that this code resolves the error and meets the requirements specified in the original SPEC. You must include ALL of the code, not just a partial fix.

Remember to consider the context of the code running inside an iframe and ensure your solution is compatible with this environment. Your goal is to provide a working solution that resolves the error while maintaining the intended functionality described in the SPEC.
`;

/**
 * Given a broken charm, an error, and a model, returns a recipe with the fixed code.
 * @param spec - The specification/description of the web application.
 * @param code - The code of the web application.
 * @param schema - The schema of the web application.
 * @param error - The error stacktrace that resulted from running the code.
 * @param model - The model to use to generate the description. (default: "anthropic:claude-3-5-sonnet-latest")
 * @returns The recipe.
 */
export async function fixRecipePrompt(
  spec: string,
  code: string,
  schema: string,
  error: string,
  model: string = "google:gemini-2.0-pro",
) {
  const system = hydratePrompt(SYSTEM_PROMPT, {
    SPEC: spec,
    CODE: code,
    SCHEMA: schema,
    ERROR: error,
  });
  const prompt = `Please fix the code, do not be lazy, or leave comments about code you didn't include. Include all of the code.`;
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

  // console.log("RESPONSE", parseTagFromResponse(response, "fixed_code"));
  return parseTagFromResponse(response, "fixed_code");
}
