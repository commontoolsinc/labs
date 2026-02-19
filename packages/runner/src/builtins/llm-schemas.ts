import type { JSONSchema } from "@commontools/api";

export const LLMContentSchema = {
  anyOf: [
    { type: "string" },
    {
      type: "array",
      items: {
        anyOf: [{
          type: "object",
          properties: {
            type: { type: "string" },
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

export const LLMMessageSchema = {
  type: "object",
  properties: {
    role: { type: "string" },
    content: LLMContentSchema,
  },
  required: ["role", "content"],
} as const satisfies JSONSchema;

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

export const LLMReducedToolSchema = {
  type: "object",
  properties: {
    description: { type: "string" },
    inputSchema: { type: "object" },
  },
} as const satisfies JSONSchema;

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
  },
  required: ["messages"],
} as const satisfies JSONSchema;
