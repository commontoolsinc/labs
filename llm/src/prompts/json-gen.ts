import JSON5 from "json5";
import { hydratePrompt, parseTagFromResponse } from "./prompting.ts";
import { client } from "../client.ts";
import { llmPrompt } from "../index.ts";

const SYSTEM_PROMPT = llmPrompt(
  "json-gen-system",
  `
You are an expert JSON data generator AI. Your task is to design and generate a JSON blob that models and illustrates the data structure that would enable a product feature or idea described by a user.

These are small discrete features, not entire products.

You will be given a product description in the following format:
<product_description>
{{PRODUCT_DESCRIPTION}}
</product_description>

Your goal is to create a comprehensive and well-structured JSON that represents the data model for the described product feature or idea. Follow these guidelines:

1. Analyze the product description carefully to identify key entities, attributes, and relationships.
2. Design a JSON structure that captures all necessary data points and their relationships.
3. Use appropriate data types for each field (e.g., string, number, boolean, array, object).
4. Include any necessary metadata fields (e.g., id, timestamps, version).
5. Consider scalability and flexibility in your design to accommodate potential future enhancements.
6. Use clear and descriptive names for all fields and objects.
7. Organize the structure logically, grouping related data together.

Before generating the final JSON output, use a <scratchpad> to outline your thoughts and plan the structure of your JSON. Consider the following questions:

- What are the main entities in this product feature?
- What attributes does each entity need?
- How are these entities related to each other?
- What data types are appropriate for each attribute?
- Are there any arrays or nested objects required?
- What metadata might be useful for this feature?
- Are you over-engineering the JSON structure? Keep it simple, and we can always add more fields later.

After your analysis, generate the JSON blob. Your output should be valid JSON, containing only the JSON blob itself without any additional text or explanations. Ensure that your JSON blob is well-formatted and properly indented for readability.

Begin your response with a <scratchpad> section for your thought process, followed by the JSON blob enclosed in <json_blob> tags.
`,
);

const PROMPT = llmPrompt(
  "json-gen-user",
  `Create a JSON object that illustrates the <product_description>`,
);
/**
 * Generates a JSON object with hallucinated data from a product/feature description.
 * @param description - The product/feature description to generate a JSON object from.
 * @param model - The model to use to generate the JSON object.
 * @returns The generated JSON object.
 */
export async function generateJSON(
  description: string,
  model: string = "groq:llama-3.3-70b-versatile",
  cache: boolean = true,
): Promise<Record<string, unknown>> {
  const system = hydratePrompt(SYSTEM_PROMPT, {
    PRODUCT_DESCRIPTION: description,
  });
  const response = await client.sendRequest({
    model,
    system: system.text,
    stream: false,
    messages: [
      {
        role: "user",
        content: PROMPT.text,
      },
    ],
    mode: "json",
    metadata: {
      context: "json-gen",
      systemPrompt: system.version,
      userPrompt: PROMPT.version,
    },
    cache,
  });

  const jsonString = parseTagFromResponse(response, "json_blob");

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
