import { LLMClient } from "@commontools/llm-client";

export const llmUrl = typeof window !== "undefined"
  ? globalThis.location.protocol + "//" + globalThis.location.host +
    "/api/ai/llm"
  : "//api/ai/llm";

export const llm = new LLMClient(llmUrl);
