import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";
import { z } from "zod";
import { toZod } from "@commontools/utils/zod-utils";
import {
  type LLMGenerateObjectRequest,
  type LLMRequest,
} from "@commontools/llm/types";

const tags = ["AI Language Models"];

const TextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const ImagePartSchema = z.object({
  type: z.literal("image"),
  image: z.string(),
});

const ToolCallPartSchema = z.object({
  type: z.literal("tool-call"),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.record(z.any()),
});

const ToolResultPartSchema = z.object({
  type: z.literal("tool-result"),
  toolCallId: z.string(),
  toolName: z.string(),
  output: z.any(),
  error: z.string().optional(),
});

const MessageContentSchema = z.discriminatedUnion("type", [
  TextPartSchema,
  ImagePartSchema,
  ToolCallPartSchema,
  ToolResultPartSchema,
]);

export const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(MessageContentSchema)]),
});

export const LLMRequestSchema = toZod<LLMRequest>().with({
  messages: z.array(MessageSchema) as any, // Trust our BuiltInLLMMessage = CoreMessage alignment
  system: z.string().optional(),
  model: z.string().openapi({
    example: "claude-sonnet-4-5",
  }),
  maxTokens: z.number().optional(),
  stop: z.string().optional(),
  stream: z.boolean().optional(),
  mode: z.enum(["json"]).optional(),
  metadata: z.record(z.union([z.string(), z.any()])).optional(),
  cache: z.boolean().default(true).optional(),
  tools: z.record(z.object({
    description: z.string(),
    inputSchema: z.record(z.any()),
    handler: z.function().optional().openapi({
      type: "object",
      description:
        "Function handler for tool execution (not serialized in API)",
    }),
  })).optional(),
});

export const GenerateObjectRequestSchema = toZod<LLMGenerateObjectRequest>()
  .with({
    prompt: z.string(),
    schema: z.record(z.string(), z.any()),
    system: z.string().optional(),
    cache: z.boolean().default(true).optional(),
    maxTokens: z.number().optional(),
    model: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  });

export const ModelInfoSchema = z.object({
  capabilities: z.object({
    contextWindow: z.number(),
    maxOutputTokens: z.number(),
    streaming: z.boolean(),
    systemPrompt: z.boolean(),
    systemPromptWithImages: z.boolean().optional(),
    stopSequences: z.boolean(),
    prefill: z.boolean(),
    images: z.boolean(),
  }),
  name: z.string(),
  aliases: z.array(z.string()),
});

export const ModelsResponseSchema = z.record(ModelInfoSchema);

const StreamResponse = z.object({
  type: z.literal("stream"),
  body: z.instanceof(ReadableStream),
});

const JsonResponse = z.object({
  type: z.literal("json"),
  body: MessageSchema.openapi({
    example: {
      role: "assistant",
      content:
        "Arr! That be a mighty fine tongue-twister ye got there, matey! *adjusts eye patch*\n\nAs any seasoned sea dog would tell ye, a woodchuck (if the scurvy beast could chuck wood) would chuck as much wood as a woodchuck could chuck if a woodchuck could chuck wood! \n\nBut between you and me, shipmate, we pirates care more about how much booty we can plunder than how much wood them landlubbing woodchucks can chuck! Yarr har har! 🏴‍☠️",
    },
  }),
});

export type LLMJSONResponse = z.infer<typeof JsonResponse>;

const GetModelsRouteQueryParams = z.object({
  search: z.string().optional(),
  capability: z.string().optional(),
  task: z.string().optional(),
});

export type GetModelsRouteQueryParams = z.infer<
  typeof GetModelsRouteQueryParams
>;

export const FeedbackSchema = z.object({
  span_id: z.string(),
  name: z.string().default("user feedback"),
  annotator_kind: z.enum(["HUMAN", "LLM"]).default("HUMAN"),
  result: z.object({
    label: z.string().optional(),
    score: z.number().optional(),
    explanation: z.string().optional(),
  }),
  metadata: z.record(z.unknown()).optional(),
});

// Route definitions
export const getModels = createRoute({
  path: "/api/ai/llm/models",
  method: "get",
  tags,
  query: GetModelsRouteQueryParams,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      ModelsResponseSchema.openapi({
        example: {
          "claude-3-5-sonnet": {
            name: "claude-3-5-sonnet",
            capabilities: {
              contextWindow: 200000,
              maxOutputTokens: 8192,
              images: true,
              prefill: true,
              systemPrompt: true,
              stopSequences: true,
              streaming: true,
            },
            aliases: [
              "anthropic:claude-3-5-sonnet-latest",
              "claude-3-5-sonnet",
            ],
          },
        },
      }),
      "Available LLM models and their capabilities",
    ),
  },
});

export const generateText = createRoute({
  path: "/api/ai/llm",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: LLMRequestSchema.openapi({
            example: {
              model: "anthropic:claude-sonnet-4-5",
              system: "You are a pirate, make sure you talk like one.",
              stream: false,
              cache: true,
              messages: [
                {
                  role: "user",
                  content:
                    "how much wood would a woodchuck chuck if a woodchuck could chuck wood?",
                },
              ],
            },
          }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: JsonResponse,
        },
        "text/event-stream": {
          schema: StreamResponse,
        },
      },
      description:
        "Generated text response. NOTE: If you make a request with `stream: true`, the server response will just be a stream of newline separated strings returned from the LLM, without a structured message object.",
    },
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description: "Invalid request parameters",
    },
  },
});

export const feedback = createRoute({
  path: "/api/ai/llm/feedback",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: FeedbackSchema.openapi({
            example: {
              span_id: "67f6740bbe1ddc3f",
              name: "correctness",
              annotator_kind: "HUMAN",
              result: {
                label: "correct",
                score: 1,
                explanation: "The response answered the question I asked",
              },
            },
          }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        success: z.boolean(),
      }).openapi({
        example: {
          success: true,
        },
      }),
      "Feedback submitted successfully",
    ),
    [HttpStatusCodes.BAD_REQUEST]: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description: "Invalid request parameters",
    },
  },
});

export const generateObject = createRoute({
  path: "/api/ai/llm/generateObject",
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: GenerateObjectRequestSchema.openapi({
            example: {
              prompt:
                "What is the first thing that comes to mind when I say 'apple'?",
              schema: {
                type: "object",
                properties: {
                  idea: { type: "string" },
                  reason: { type: "string" },
                  silliness: { type: "number" },
                },
                required: ["idea", "reason", "silliness"],
              },
            },
          }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        object: z.any(),
        id: z.string().optional(),
      }).openapi({
        example: {
          object: {
            idea: "apple",
            reason: "It's a fruit",
            silliness: 0.5,
          },
          id: "123",
        },
      }),
      "Generated object",
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      z.object({
        error: z.string(),
      }).openapi({
        example: {
          error: "idea is missing",
        },
      }),
      "Invalid request parameters",
    ),
  },
});

export type GetModelsRoute = typeof getModels;
export type GenerateTextRoute = typeof generateText;
export type FeedbackRoute = typeof feedback;
export type GenerateObjectRoute = typeof generateObject;
