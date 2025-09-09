import { LLMClient } from "../client.ts";
import { GenerationOptions, llmPrompt } from "../index.ts";
import { applyDefaults } from "../options.ts";
import { DEFAULT_MODEL_NAME, extractTextFromLLMResponse } from "../types.ts";
import { hydratePrompt, parseTagFromResponse } from "./prompting.ts";
import { recipeGuidePrompt } from "./recipe-guide.ts";

const SYSTEM_PROMPT = hydratePrompt(
  llmPrompt(
    "recipe-fix-system",
    `
You are a code debugging and fixing assistant. Your task is to analyze buggy code that has caused errors and crashes, and then generate fixed code based on the original specifications. The code runs inside an iframe, and errors bubble up from there.

IMPORTANT: The code provided is ONLY THE USER CODE PORTION of a larger template. You must ONLY return the user code portion, NOT a complete HTML page or iframe template. Your fixed code should be a direct replacement for just the user code region.

The code running inside the iframe is a "recipe", which must follow the following guide:

{{RECIPE_GUIDE}}

----

You will be provided with the following information:

1. SPEC: The original prompt or specifications for the code.
2. CODE: The existing user code that is causing errors (this is ONLY the user code portion, not the full template).
3. SCHEMA: The current data schema related to the code.
4. ERROR: The error stacktrace that resulted from running the code.

Here's the original SPEC (prompt) for the code:

<spec>
{{SPEC}}
</spec>

This is the existing USER CODE that's causing errors:
<code>
{{CODE}}
</code>

Here's the current SCHEMA:
<schema>
{{SCHEMA}}
</schema>

And this is the ERROR stacktrace:
<e>
{{ERROR}}
</e>

Your task is to:

1. Carefully analyze the error stacktrace and the existing code.
2. Identify the cause of the error and any potential issues in the code that don't align with the original SPEC.
3. Generate new, fixed user code that resolves the error and adheres to the original SPEC.

When writing your response:

1. First, provide a brief explanation of the error and its likely cause inside <error_analysis> tags.
2. Then, write the new, fixed USER CODE inside <fixed_code> tags. Ensure that this code resolves the error and meets the requirements specified in the original SPEC.

CRITICAL:
- Your fixed code should ONLY include the user code portion, NOT a complete HTML document or template.
- Do NOT include any <html>, <head>, <body> tags or other template elements.
- ONLY include the JavaScript code that defines onLoad, onReady, and title functions.
- Your response will be injected into an existing template structure.

Remember to consider the context of the code running inside an iframe and ensure your solution is compatible with this environment. Your goal is to provide a working solution that resolves the error while maintaining the intended functionality described in the SPEC.`,
  ),
  {
    RECIPE_GUIDE: recipeGuidePrompt,
  },
);

/**
 * Given a broken charm, an error, and a model, returns a recipe with the fixed code.
 * @param spec - The specification/description of the web application.
 * @param code - The code of the web application.
 * @param schema - The schema of the web application.
 * @param error - The error stacktrace that resulted from running the code.
 * @param model - The model to use to generate the description. (default: "anthropic:claude-3-7-sonnet-latest")
 * @returns The recipe.
 */
export async function fixRecipePrompt(
  spec: string,
  code: string,
  schema: string,
  error: string,
  options?: GenerationOptions,
) {
  const system = hydratePrompt(SYSTEM_PROMPT, {
    SPEC: spec,
    CODE: code,
    SCHEMA: schema,
    ERROR: error,
  });
  const prompt = llmPrompt(
    "recipe-fix-user",
    `Please fix the code. Remember to only return the user code portion, not the full template. Do not include any HTML, head, or body tags - just the JavaScript functions.`,
  );

  const { model, cache, space, generationId } = applyDefaults(options);

  const response = await new LLMClient().sendRequest({
    model,
    system: system.text,
    stream: false,
    messages: [
      {
        role: "user",
        content: prompt.text,
      },
    ],
    metadata: {
      context: "workflow",
      workflow: "recipe-fix",
      systemPrompt: system.version,
      userPrompt: prompt.version,
      space,
      generationId,
    },
    cache,
  });

  // console.log("RESPONSE", parseTagFromResponse(response, "fixed_code"));
  return parseTagFromResponse(extractTextFromLLMResponse(response), "fixed_code");
}
