import {
  type BuiltInLLMContent,
  type BuiltInLLMTool,
  generateObject,
  type ImmutableJSONValue,
  pattern,
} from "commonfabric";
import type { JSONSchema } from "commonfabric";

type SubAgentInput = {
  prompt: BuiltInLLMContent;
  context?: Record<string, any>;
  resultSchema: JSONSchema | string;
  system?: string;
  tools?: Record<string, BuiltInLLMTool>;
  model?: string;
  maxTokens?: number;
  observationMaxConfidentiality?: readonly ImmutableJSONValue[];
  schemaSanitizePromptInjection?: boolean;
};

export const subAgentPattern = pattern<SubAgentInput, any>((
  {
    prompt,
    context,
    resultSchema,
    system,
    tools,
    model,
    maxTokens,
    observationMaxConfidentiality,
    schemaSanitizePromptInjection,
  },
) => {
  const parsedResultSchema = typeof resultSchema === "string"
    ? JSON.parse(resultSchema)
    : resultSchema;

  const response = generateObject({
    prompt,
    context,
    system,
    tools,
    model,
    maxTokens,
    observationMaxConfidentiality,
    schemaSanitizePromptInjection,
    schema: parsedResultSchema,
  });

  return response.error ? { error: response.error } : response.result;
});
