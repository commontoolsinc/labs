import { registerOTel } from "@vercel/otel";
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import {
  isOpenInferenceSpan,
  OpenInferenceSimpleSpanProcessor,
} from "@arizeai/openinference-vercel";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { SEMRESATTRS_PROJECT_NAME } from "@arizeai/openinference-semantic-conventions";

// For troubleshooting, set the log level to DiagLogLevel.DEBUG
// This is not required and should not be added in a production setting
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);

export function register() {
  registerOTel({
    serviceName: Deno.env.get("PHOENIX_PROJECT"),
    attributes: {
      // This is not required but it will allow you to send traces to a specific project in phoenix
      [SEMRESATTRS_PROJECT_NAME]: Deno.env.get("PHOENIX_PROJECT"),
    },
    spanProcessors: [
      new OpenInferenceSimpleSpanProcessor({
        exporter: new OTLPTraceExporter({
          url: Deno.env.get("PHOENIX_URL"),
        }),
        spanFilter: span => {
          // Only export spans that are OpenInference to remove non-generative spans
          // This should be removed if you want to export all spans
          return isOpenInferenceSpan(span);
        },
      }),
    ],
  });
}
