import {
  type BuiltInLLMContent,
  type BuiltInLLMMessage,
  type BuiltInLLMTool,
  generateObject,
  type ImmutableJSONValue,
  lift,
  pattern,
} from "commonfabric";
import type { JSONSchema } from "commonfabric";

type ResultSchemaInput = any;

type SubAgentInput = {
  prompt: BuiltInLLMContent;
  messages?: BuiltInLLMMessage[];
  context?: Record<string, any>;
  resultSchema: ResultSchemaInput;
  system?: string;
  tools?: Record<string, BuiltInLLMTool>;
  model?: string;
  maxTokens?: number;
  observationMaxConfidentiality?: readonly ImmutableJSONValue[];
  schemaSanitizePromptInjection?: boolean;
};

const parseResultSchema = lift<
  { resultSchema: ResultSchemaInput },
  JSONSchema
>(({ resultSchema }) => {
  if (typeof resultSchema === "string") {
    return JSON.parse(resultSchema);
  }
  if (
    typeof resultSchema === "boolean" ||
    (resultSchema !== null && typeof resultSchema === "object" &&
      !Array.isArray(resultSchema))
  ) {
    return resultSchema as JSONSchema;
  }
  return true;
});

const appendPromptMessage = lift<
  { messages?: BuiltInLLMMessage[]; prompt: BuiltInLLMContent },
  BuiltInLLMMessage[]
>(({ messages, prompt }) => [
  ...(messages ?? []),
  { role: "user" as const, content: prompt },
]);

export const subAgentPattern = pattern<SubAgentInput, any>((
  {
    prompt,
    messages,
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
  const parsedResultSchema = parseResultSchema({ resultSchema });
  const requestMessages = appendPromptMessage({ messages, prompt });

  const response = generateObject({
    messages: requestMessages,
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
