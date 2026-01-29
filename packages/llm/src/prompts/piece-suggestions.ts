import { hydratePrompt, parseTagFromResponse } from "./prompting.ts";
import { LLMClient } from "../client.ts";
import JSON5 from "json5";
import { describePiece } from "./piece-describe.ts";
import { applyDefaults, llmPrompt } from "../index.ts";
import { extractTextFromLLMResponse } from "../types.ts";
import { GenerationOptions } from "../options.ts";

const SYSTEM_PROMPT = llmPrompt(
  "piece-suggestions-system",
  `
You are tasked with generating prompt suggestions to iterate on web app functionality in new and interesting directions.

You will be provided with three inputs: a SPEC (text description of the functionality), CODE (React app implementation), and SCHEMA (JSON schema). Your goal is to analyze these inputs and generate potential prompt suggestions for incremental updates and tweaks to the web app.

Here are the inputs:

<SPEC>
{{SPEC}}
</SPEC>

<CODE>
{{CODE}}
</CODE>

<SCHEMA>
{{SCHEMA}}
</SCHEMA>

Follow these steps to complete the task:

1. Carefully review the SPEC, CODE, and SCHEMA to understand the current functionality and structure of the web app.

2. Identify key features, limitations, or potential areas for improvement in the current implementation.

3. Think creatively about how the web app could be expanded, modified, or enhanced in interesting ways.

4. Generate distinct prompt suggestions, each 1 sentence long, that propose new directions or features for the web app.

5. Ensure that each suggestion is:
    - Relevant to the existing functionality
    - Adds value to the user experience
    - Feasible within a single incremental update to the web app
    - Distinct from the other suggestions

6. Format your output as a JSON list of objects, where each object represents a prompt suggestion and has a "prompt" key with the suggestion as its value.

7. Include the "type" key with one of the following values: "aesthetic", "creative", "practical", "feature", or "other".

Your final output should be wrapped in <output> tags as follows:

<output>
[
  {
    "prompt": "Your first prompt suggestion here.",
    "type": "creative"
  },
  {
    "prompt": "Your second prompt suggestion here.",
    "type": "aesthetic"
  },
  {
    "prompt": "Your third prompt suggestion here.",
    "type": "feature"
  }
]
</output>

Remember to be creative and think outside the box while still maintaining relevance to the original web app functionality.
`,
);

export interface PieceSuggestion {
  prompt: string;
  type: "aesthetic" | "creative" | "practical" | "feature" | "other";
}

/**
 * Generates piece suggestions from a spec, code, and schema.
 * @param spec - The spec of the web app.
 * @param code - The code of the web app.
 * @param schema - The schema of the web app.
 * @param count - The number of piece suggestions to generate. (default: 3)
 * @param model - The model to use to generate the piece suggestions. (default: "anthropic:claude-sonnet-4-5")
 * @returns The generated piece suggestions.
 */
export async function generatePieceSuggestions(
  spec: string,
  code: string,
  schema: string,
  count: number = 3,
  options?: GenerationOptions,
): Promise<PieceSuggestion[]> {
  const optionsWithDefaults = applyDefaults(options);
  const { model, cache, space, generationId } = optionsWithDefaults;

  // FIXME(jake): Currently, whenever we iterate, we are overwriting
  // the entire spec, so we lose context of the original spec.
  //
  // To work around this, we we first generate a description of the piece, and
  // then we'll use that as a stand-in for the spec.
  const description = await describePiece(
    spec,
    code,
    schema,
    optionsWithDefaults,
  );

  const system = hydratePrompt(SYSTEM_PROMPT, {
    SPEC: description,
    CODE: code,
    SCHEMA: schema,
  });

  const prompt = llmPrompt(
    "piece-suggestions-user",
    `Give me ${count} piece suggestions`,
  );

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
      context: "piece-suggestions",
      systemPrompt: system.version,
      userPrompt: prompt.version,
      space,
      generationId,
    },
    cache,
  });

  const jsonString = parseTagFromResponse(
    extractTextFromLLMResponse(response),
    "output",
  );

  if (!jsonString) {
    throw new Error("No JSON blob found in response");
  }

  try {
    const jsonObject = JSON5.parse(jsonString);
    return jsonObject;
  } catch (error) {
    console.error("Parsing error:", error);
    throw new Error("Failed to parse JSON blob");
  }
}
