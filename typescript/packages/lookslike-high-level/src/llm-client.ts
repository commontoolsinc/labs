import { LLMClient } from "@commontools/llm-client";
export const LLM_SERVER_URL =
  window.location.protocol + "//" + window.location.host + "/api/llm";

export const suggestionClient = new LLMClient({
  serverUrl: LLM_SERVER_URL,
  system:
    "You are an assistant that helps match user queries to relevant data gems based on their names and types.",
  tools: [],
});

export const mockResultClient = new LLMClient({
  serverUrl: LLM_SERVER_URL,
  system: `Generate dummy data as JSON as per the provided spec. Use the input to imagine what an API response would look like for a request.`,
  tools: [],
});
