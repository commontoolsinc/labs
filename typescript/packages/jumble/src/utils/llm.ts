import { LLMClient } from "@commontools/llm-client";

export const llmUrl =
  typeof window !== "undefined"
    ? window.location.protocol + "//" + window.location.host + "/api/ai/llm"
    : "//api/ai/llm";

export const llm = new LLMClient(llmUrl);
