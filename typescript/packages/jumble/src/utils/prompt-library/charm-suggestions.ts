import { hydratePrompt, parseTagFromResponse } from "@/utils/prompt-library/prompting";
import { llm } from "@/utils/llm";
import JSON5 from "json5";
import { describeCharm } from "@/utils/prompt-library/charm-describe";
const SYSTEM_PROMPT = `
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
`;

export interface CharmSuggestion {
  prompt: string;
  type: "aesthetic" | "creative" | "practical" | "feature" | "other";
}

/**
 * Generates charm suggestions from a spec, code, and schema.
 * @param spec - The spec of the web app.
 * @param code - The code of the web app.
 * @param schema - The schema of the web app.
 * @param count - The number of charm suggestions to generate. (default: 3)
 * @param model - The model to use to generate the charm suggestions. (default: "groq:llama-3.3-70b-versatile")
 * @returns The generated charm suggestions.
 */
export async function generateCharmSuggestions(
  spec: string,
  code: string,
  schema: string,
  count: number = 3,
  model: string = "groq:llama-3.3-70b-versatile",
): Promise<CharmSuggestion[]> {
  // FIXME(jake): Currently in jumble, whenever we iterate, we are overwriting
  // the entire spec, so we lose context of the original spec.
  //
  // To work around this, we we first generate a description of the charm, and
  // then we'll use that as a stand-in for the spec.
  const description = await describeCharm(spec, code, schema, model);

  const system = hydratePrompt(SYSTEM_PROMPT, { SPEC: description, CODE: code, SCHEMA: schema });

  const prompt = `Give me ${count} charm suggestions`;

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

  const jsonString = parseTagFromResponse(response, "output");

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
