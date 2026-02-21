import type { JSONSchema } from "@commontools/api";

/** Runtime schema for {@link BuiltInLLMContent} (packages/api/index.ts). */
export const LLMContentSchema = {
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
} as const satisfies JSONSchema;

/** Runtime schema for {@link BuiltInLLMMessage} (packages/api/index.ts). */
export const LLMMessageSchema = {
  type: "object",
  properties: {
    role: { type: "string", enum: ["user", "assistant", "system", "tool"] },
    content: LLMContentSchema,
  },
  required: ["role", "content"],
} as const satisfies JSONSchema;

/** Runtime schema for {@link BuiltInLLMTool} (packages/api/index.ts). */
export const LLMToolSchema = {
  type: "object",
  properties: {
    description: { type: "string" },
    inputSchema: { type: "object" },
    handler: {
      // Deliberately no schema, so it gets populated from the handler
      asStream: true,
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
      asCell: true,
    },
    extraParams: { type: "object" },
    piece: {
      // Accept whole piece - its own schema defines its handlers
      asCell: true,
    },
  },
  required: [],
} as const satisfies JSONSchema;

/** Runtime schema for reduced tool info sent to the LLM provider. */
export const LLMReducedToolSchema = {
  type: "object",
  properties: {
    description: { type: "string" },
    inputSchema: { type: "object" },
  },
} as const satisfies JSONSchema;

/** Runtime schema for {@link BuiltInLLMParams} (packages/api/index.ts). */
export const LLMParamsSchema = {
  type: "object",
  properties: {
    messages: { type: "array", items: LLMMessageSchema, default: [] },
    model: { type: "string" },
    maxTokens: { type: "number" },
    system: { type: "string" },
    stop: { type: "string" },
    tools: { type: "object", additionalProperties: LLMToolSchema, default: {} },
    context: {
      type: "object",
      additionalProperties: { asCell: true },
      default: {},
    },
    resultSchema: { type: "object" },
  },
  required: ["messages"],
} as const satisfies JSONSchema;

/** Runtime schema for {@link BuiltInGenerateTextParams} (packages/api/index.ts). */
export const GenerateTextParamsSchema = {
  type: "object",
  properties: {
    prompt: LLMContentSchema,
    messages: { type: "array", items: LLMMessageSchema },
    context: {
      type: "object",
      additionalProperties: { asCell: true },
      default: {},
    },
    system: { type: "string" },
    model: { type: "string" },
    maxTokens: { type: "number" },
    tools: { type: "object", additionalProperties: LLMToolSchema, default: {} },
  },
} as const satisfies JSONSchema;

/** Runtime schema for {@link BuiltInGenerateObjectParams} (packages/api/index.ts). */
export const GenerateObjectParamsSchema = {
  type: "object",
  properties: {
    prompt: LLMContentSchema,
    messages: { type: "array", items: LLMMessageSchema },
    context: {
      type: "object",
      additionalProperties: { asCell: true },
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
} as const satisfies JSONSchema;

/** Runtime schema for the result of the `llm` builtin. */
export const LLMResultSchema = {
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
} as const satisfies JSONSchema;

/** Runtime schema for the result of the `generateText` builtin. */
export const GenerateTextResultSchema = {
  type: "object",
  properties: {
    pending: { type: "boolean", default: false },
    result: { type: "string" },
    error: {},
    partial: { type: "string" },
    requestHash: { type: "string" },
  },
  required: ["pending"],
} as const satisfies JSONSchema;

/** Runtime schema for the result of the `generateObject` builtin. */
export const GenerateObjectResultSchema = {
  type: "object",
  properties: {
    pending: { type: "boolean", default: false },
    result: { type: "object" },
    error: {},
    partial: { type: "string" },
    requestHash: { type: "string" },
  },
  required: ["pending"],
} as const satisfies JSONSchema;
