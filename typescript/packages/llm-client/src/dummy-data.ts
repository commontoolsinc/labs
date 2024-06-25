import { Schema } from "@cfworker/json-schema";
import { LLMClient } from "./index.js";

export function grabJson(txt: string) {
  return JSON.parse(txt.match(/```json\n([\s\S]+?)```/)?.[1] ?? "{}");
}

export async function generateData<T>(
  client: LLMClient,
  description: string,
  inputData: any,
  jsonSchema: Schema,
) {
  const request = `
  You specialize in generating believable and useful data for testing applications during development. Take the provided input parameters and use them to hallucinate a plausible result that conforms to the following JSON schema:

  <schema>${JSON.stringify(jsonSchema)}</schema>

  <description>${description}</description>
  <input>${JSON.stringify(inputData)}</input>

  Respond with only the generated data in a JSON block.`;

  const thread = await client.createThread(request);
  const response = thread.conversation[thread.conversation.length - 1];

  return grabJson(response) as T;
}
