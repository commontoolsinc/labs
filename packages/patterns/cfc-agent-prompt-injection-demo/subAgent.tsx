import {
  type BuiltInLLMContent,
  type BuiltInLLMTool,
  generateObject,
  type ImmutableJSONValue,
  lift,
  pattern,
  patternTool,
} from "commonfabric";
import type { JSONSchema } from "commonfabric";

type ResultSchemaInput = any;

type SubAgentInput = {
  prompt: BuiltInLLMContent;
  context?: Record<string, any>;
  resultSchema: ResultSchemaInput;
  system?: string;
  tools?: Record<string, BuiltInLLMTool>;
  model?: string;
  maxTokens?: number;
  observationMaxConfidentiality?: readonly ImmutableJSONValue[];
  schemaSanitizePromptInjection?: boolean;
};

const structuredOutputOnlyTool = pattern<Record<string, never>, { ok: true }>(
  () => ({ ok: true }),
);

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
  const parsedResultSchema = parseResultSchema({ resultSchema });
  const fallbackTools = {
    structuredOutputOnly: {
      description:
        "Private implementation detail. Do not call this tool; call presentResult with the final structured result instead.",
      ...patternTool(structuredOutputOnlyTool),
    },
  };
  const effectiveTools = tools ? tools : fallbackTools;

  const response = generateObject({
    prompt,
    context,
    system,
    tools: effectiveTools,
    model,
    maxTokens,
    observationMaxConfidentiality,
    schemaSanitizePromptInjection,
    schema: parsedResultSchema,
  });

  return response.error ? { error: response.error } : response.result;
});
