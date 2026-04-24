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
  resultSchema: JSONSchema;
  system?: string;
  tools?: Record<string, BuiltInLLMTool>;
  model?: string;
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
    observationMaxConfidentiality,
    schemaSanitizePromptInjection,
  },
) =>
  generateObject({
    prompt,
    context,
    system,
    tools,
    model,
    observationMaxConfidentiality,
    schemaSanitizePromptInjection,
    schema: resultSchema,
  }).result
);
