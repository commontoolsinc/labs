# Configuring Memory Service for OpenTelemetry Collector

To use the OpenTelemetry collector with the memory service and implement sampling, follow these steps:

## 1. Add OpenTelemetry SDK Dependencies

Add the following dependencies to your `memory/deno.json` file:

```json
"imports": {
  "@opentelemetry/api": "npm:@opentelemetry/api@^1.9.0",
  "@opentelemetry/sdk-node": "npm:@opentelemetry/sdk-node@^0.49.0",
  "@opentelemetry/sdk-trace-base": "npm:@opentelemetry/sdk-trace-base@^1.22.0",
  "@opentelemetry/exporter-trace-otlp-proto": "npm:@opentelemetry/exporter-trace-otlp-proto@^0.49.0",
  "@opentelemetry/resources": "npm:@opentelemetry/resources@^1.22.0",
  "@opentelemetry/semantic-conventions": "npm:@opentelemetry/semantic-conventions@^1.22.0"
}
```

## 2. Create an OpenTelemetry Initialization File

Create a new file in the memory directory called `otel-init.ts`:

```typescript
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";

// For troubleshooting, set the log level to DiagLogLevel.DEBUG
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

// Configure the OTLP exporter to send to the collector
const otlpExporter = new OTLPTraceExporter({
  url: Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT") || "http://localhost:4317",
});

// Create and configure the OpenTelemetry SDK
export const otelSDK = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: "memory",
    [SemanticResourceAttributes.SERVICE_VERSION]: "1.0.0",
  }),
  traceExporter: otlpExporter,
});

// Initialize the SDK
export function initializeOtel() {
  // Start the SDK
  otelSDK.start()
    .then(() => console.log("OpenTelemetry initialized"))
    .catch((error) => console.error("Error initializing OpenTelemetry", error));

  // Gracefully shut down the SDK on process exit
  Deno.addSignalListener("SIGTERM", () => {
    otelSDK.shutdown()
      .then(() => console.log("OpenTelemetry SDK shut down"))
      .catch((error) => console.error("Error shutting down OpenTelemetry SDK", error));
  });
}
```

## 3. Update Your Memory Service Entry Point

In your main file (e.g., `deno.ts` or where your server is initialized), add:

```typescript
import { initializeOtel } from "./otel-init.ts";

// Initialize OpenTelemetry before starting the service
initializeOtel();

// Rest of your code...
```

## 4. Configure Sampling in the Memory Service

Update your telemetry.ts file to use the sampling from the OpenTelemetry SDK instead of doing manual sampling:

```typescript
// In telemetry.ts, change the config to:
let config: MemoryInstrumentationConfig = {
  enabled: true,
  // Set this to 1.0 as sampling is now handled by the collector
  samplingRate: 1.0, 
};

// Remove the sampling check in traceSync and traceAsync functions
// For example, in traceSync:
export function traceSync<T>(
  name: string,
  fn: (span: Span) => T,
  attributes: Record<string, string | number | boolean> = {},
): T {
  // Skip if telemetry is disabled
  if (!config.enabled) {
    return fn({} as Span);
  }
  
  // Rest of the function...
}

// Do the same for traceAsync
```

## 5. Set Environment Variables for Your Application

When running the Memory service, set these environment variables:

```bash
# Send traces to the local collector
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317

# Add this for debugging if needed
export OTEL_LOG_LEVEL=info
```

## 6. Running Your Application

1. Start the OpenTelemetry collector:
   ```
   cd otel-collector
   ./collector.sh start
   ```

2. Start your Memory service with the environment variables set.

This will ensure your memory service traces are sent to the collector, which will apply sampling before forwarding to Honeycomb, reducing your span volume.