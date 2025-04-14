import { registerOTel } from "@vercel/otel";
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import {
  isOpenInferenceSpan,
  OpenInferenceSimpleSpanProcessor,
} from "@arizeai/openinference-vercel";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { SEMRESATTRS_PROJECT_NAME } from "@arizeai/openinference-semantic-conventions";
import env from "@/env.ts";

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

export function register() {
  registerOTel({
    serviceName: env.CTTS_AI_LLM_PHOENIX_PROJECT,
    attributes: {
      [SEMRESATTRS_PROJECT_NAME]: env.CTTS_AI_LLM_PHOENIX_PROJECT,
    },
    spanProcessors: [
      new OpenInferenceSimpleSpanProcessor({
        exporter: new OTLPTraceExporter({
          url: env.CTTS_AI_LLM_PHOENIX_URL,
          headers: {
            "Content-Type": "application/x-protobuf", // Changed from application/json
            api_key: env.CTTS_AI_LLM_PHOENIX_API_KEY,
            Authorization: `Bearer ${env.CTTS_AI_LLM_PHOENIX_API_KEY}`,
          },
        }),
        spanFilter: (span) => {
          // console.log("SPAN", span);
          const includeSpanCriteria = [
            isOpenInferenceSpan(span),
            span.attributes["http.route"] == "/api/ai/llm", // Include the root span, which is in the hono app
            span.instrumentationLibrary.name.includes("@vercel/otel"), // Include the actual LLM API fetch span
          ];
          return includeSpanCriteria.some((c) => c);
        },
      }),
    ],
  });
}
