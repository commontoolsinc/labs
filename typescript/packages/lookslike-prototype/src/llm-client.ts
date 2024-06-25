import { LLMClient } from "@commontools/llm-client";
export const LLM_SERVER_URL =
  window.location.protocol + "//" + window.location.host + "/api/llm";

export const suggestionClient = new LLMClient({
  serverUrl: LLM_SERVER_URL,
  system: "",
  tools: [],
});
