import { LLMClient } from "@commontools/llm-client";

export { SimpleMessage, SimpleContent } from "@commontools/llm-client";

export const suggestSystem = "You are an assistant that helps match user queries to relevant data gems based on their names and types."
export const jsonDataRequest = `Generate dummy data as JSON as per the provided spec. Use the input to imagine what an API response would look like for a request.`

export const LLM_SERVER_URL = window.location.protocol + "//" + window.location.host + "/api/llm";
export const makeClient = (url?: string) => new LLMClient(url || LLM_SERVER_URL);

export function dataRequest({
  description,
  inputData,
  jsonSchema,
}: {
  description: string;
  inputData: any;
  jsonSchema: any;
}) {
  return `You specialize in generating believable and useful data for testing applications during development. Take the provided input parameters and use them to hallucinate a plausible result that conforms to the following JSON schema:

  <schema>${JSON.stringify(jsonSchema)}</schema>

  <description>${description}</description>
  <input>${JSON.stringify(inputData)}</input>

  Respond with only the generated data in a JSON block.`;
}
