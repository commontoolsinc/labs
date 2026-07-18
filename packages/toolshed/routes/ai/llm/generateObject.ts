import {
  type LLMGenerateObjectRequest,
  type LLMGenerateObjectResponse,
} from "@commonfabric/llm/types";
import { findModel } from "./models.ts";
import {
  generateObject as generateObjectCore,
  jsonSchema,
  type ModelMessage,
} from "ai";
import { Ajv } from "ajv";
import { DEFAULT_GENERATE_OBJECT_MODELS } from "@commonfabric/llm";
import { trace } from "@opentelemetry/api";
import { normalizeSchemaForProvider } from "./schema.ts";

export async function generateObject(
  params: LLMGenerateObjectRequest,
): Promise<LLMGenerateObjectResponse> {
  try {
    const providerSchema = normalizeSchemaForProvider(params.schema) as Record<
      string,
      unknown
    >;
    const modelConfig = findModel(
      params.model ?? DEFAULT_GENERATE_OBJECT_MODELS,
    );
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validator = ajv.compile(providerSchema);

    const activeSpan = trace.getActiveSpan();
    const spanId = activeSpan?.spanContext().spanId;

    // Attach metadata directly to the root span
    if (activeSpan) {
      // Add the metadata from params if available
      if (params.metadata) {
        Object.entries(params.metadata).forEach(([key, value]) => {
          // Only set attributes with valid values (not undefined)
          if (value !== undefined) {
            // Handle different types to ensure we only use valid AttributeValue types
            if (
              typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean"
            ) {
              activeSpan.setAttribute(`metadata.${key}`, value);
            } else if (typeof value === "object") {
              // Convert objects to JSON strings
              activeSpan.setAttribute(`metadata.${key}`, JSON.stringify(value));
            }
          }
        });
      }
    }

    // Use messages directly - conversion happens client-side
    const messages = params.messages as ModelMessage[];

    const { object } = await generateObjectCore({
      model: modelConfig.model,
      messages,
      schema: jsonSchema(providerSchema, {
        validate: (value: unknown) => {
          if (!validator(value)) {
            return {
              success: false,
              error: new Error(JSON.stringify(validator.errors)),
            };
          }
          return {
            success: true,
            value,
          };
        },
      }),
      maxOutputTokens: params.maxTokens,
      // Registering a telemetry integration turns span collection on for every
      // AI SDK call. This route has never emitted AI SDK spans, so it opts out.
      telemetry: { isEnabled: false },
      ...(params.system && { system: params.system }),
    });

    return {
      object: object as Record<string, unknown>,
      id: spanId,
    };
  } catch (error) {
    console.error("Error generating object:", error);
    throw error instanceof Error
      ? error
      : new Error(`Failed to generate object: ${error}`);
  }
}
