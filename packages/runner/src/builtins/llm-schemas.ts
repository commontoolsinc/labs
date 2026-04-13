import { toDeepFrozenSchema } from "@commonfabric/data-model/schema-utils";

/** Runtime schema for {@link BuiltInLLMContent} (packages/api/index.ts). */
export const LLMContentSchema = toDeepFrozenSchema(
  {
    anyOf: [
      { type: "string" },
      {
        type: "array",
        items: {
          anyOf: [{
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["text", "image", "tool-call", "tool-result"],
              },
              text: { type: "string" },
              image: { type: "string" },
              toolCallId: { type: "string" },
              toolName: { type: "string" },
              input: { type: "object" },
              output: {},
            },
            required: ["type"],
          }, { type: "string" }],
        },
      },
    ],
  },
  true,
);

/** Runtime schema for {@link BuiltInLLMMessage} (packages/api/index.ts). */
export const LLMMessageSchema = toDeepFrozenSchema(
  {
    type: "object",
    properties: {
      role: { type: "string", enum: ["user", "assistant", "system", "tool"] },
      content: LLMContentSchema,
    },
    required: ["role", "content"],
  },
  true,
);

/** Runtime schema for {@link BuiltInLLMTool} (packages/api/index.ts). */
export const LLMToolSchema = toDeepFrozenSchema(
  {
    type: "object",
    properties: {
      description: { type: "string" },
      inputSchema: { type: "object" },
      handler: {
        // Deliberately no schema, so it gets populated from the handler
        asCell: ["stream"],
      },
      pattern: {
        type: "object",
        properties: {
          argumentSchema: { type: "object" },
          resultSchema: { type: "object" },
          nodes: { type: "array", items: { type: "object" } },
          program: { type: "object" },
          initial: { type: "object" },
        },
        required: ["argumentSchema", "resultSchema", "nodes"],
        asCell: ["cell"],
      },
      extraParams: { type: "object" },
      piece: {
        // Accept whole piece - its own schema defines its handlers
        asCell: ["cell"],
      },
    },
    required: [],
  } as const,
  true,
);

/** Runtime schema for reduced tool info sent to the LLM provider. */
export const LLMReducedToolSchema = toDeepFrozenSchema(
  {
    type: "object",
    properties: {
      description: { type: "string" },
      inputSchema: { type: "object" },
    },
  },
  true,
);

/** Runtime schema for {@link BuiltInLLMParams} (packages/api/index.ts). */
export const LLMParamsSchema = toDeepFrozenSchema(
  {
    type: "object",
    properties: {
      messages: { type: "array", items: LLMMessageSchema, default: [] },
      model: { type: "string" },
      maxTokens: { type: "number" },
      system: { type: "string" },
      stop: { type: "string" },
      tools: {
        type: "object",
        additionalProperties: LLMToolSchema,
        default: {},
      },
      context: {
        type: "object",
        additionalProperties: { asCell: ["cell"] },
        default: {},
      },
      resultSchema: { type: "object" },
    },
    required: ["messages"],
  } as const,
  true,
);

/** Runtime schema for {@link BuiltInGenerateTextParams} (packages/api/index.ts). */
export const GenerateTextParamsSchema = toDeepFrozenSchema(
  {
    type: "object",
    properties: {
      prompt: LLMContentSchema,
      messages: { type: "array", items: LLMMessageSchema },
      context: {
        type: "object",
        additionalProperties: { asCell: ["cell"] },
        default: {},
      },
      system: { type: "string" },
      model: { type: "string" },
      maxTokens: { type: "number" },
      tools: {
        type: "object",
        additionalProperties: LLMToolSchema,
        default: {},
      },
    },
  },
  true,
);

/** Runtime schema for {@link BuiltInGenerateObjectParams} (packages/api/index.ts). */
export const GenerateObjectParamsSchema = toDeepFrozenSchema(
  {
    type: "object",
    properties: {
      prompt: LLMContentSchema,
      messages: { type: "array", items: LLMMessageSchema },
      context: {
        type: "object",
        additionalProperties: { asCell: ["cell"] },
        default: {},
      },
      schema: { type: "object" },
      system: { type: "string" },
      model: { type: "string" },
      maxTokens: { type: "number" },
      cache: { type: "boolean" },
      metadata: { type: "object" },
      tools: { type: "object", additionalProperties: LLMToolSchema },
    },
    required: ["schema"],
  },
  true,
);

/** Runtime schema for the result of the `llm` builtin. */
export const LLMResultSchema = toDeepFrozenSchema(
  {
    type: "object",
    properties: {
      pending: { type: "boolean", default: false },
      result: {
        anyOf: [
          { type: "string" },
          { type: "array", items: { type: "object" } },
        ],
      },
      error: {},
      partial: { type: "string" },
      requestHash: { type: "string" },
    },
    required: ["pending"],
  } as const,
  true,
);

/** Runtime schema for the result of the `generateText` builtin. */
export const GenerateTextResultSchema = toDeepFrozenSchema(
  {
    type: "object",
    properties: {
      pending: { type: "boolean", default: false },
      result: { type: "string" },
      error: {},
      partial: { type: "string" },
      requestHash: { type: "string" },
    },
    required: ["pending"],
  } as const,
  true,
);

/** Runtime schema for the result of the `generateObject` builtin. */
export const GenerateObjectResultSchema = toDeepFrozenSchema(
  {
    type: "object",
    properties: {
      pending: { type: "boolean", default: false },
      result: { type: "object" },
      error: {},
      partial: { type: "string" },
      requestHash: { type: "string" },
    },
    required: ["pending"],
  } as const,
  true,
);
