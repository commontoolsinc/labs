import { Context, MiddlewareHandler } from "@hono/hono";
import { context, Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { getTracerProvider } from "@/lib/otel.ts";

// Dynamically resolve the tracer so we don't capture the no-op global tracer
const obtainTracer = () => {
  const provider = getTracerProvider();
  return provider
    ? provider.getTracer("toolshed-middleware", "1.0.0")
    : trace.getTracer("toolshed-middleware", "1.0.0");
};

export interface OtelConfig {
  /**
   * Whether to include the request body in the trace
   * @default false
   */
  includeRequestBody?: boolean;

  /**
   * Whether to include the response body in the trace
   * @default false
   */
  includeResponseBody?: boolean;

  /**
   * Custom attributes to add to the span
   */
  additionalAttributes?: Record<string, string | number | boolean>;
}

/**
 * Creates a middleware that adds OpenTelemetry tracing to all routes
 */
export function otelTracing(config: OtelConfig = {}): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    const method = c.req.method;
    const route = c.req.routePath || path;

    await obtainTracer().startActiveSpan(`${method} ${path}`, async (span) => {
      span.setAttribute("http.method", method);
      span.setAttribute("http.route", path + c.req.routePath);
      span.setAttribute("http.host", c.req.header("host") || "unknown");
      span.setAttribute(
        "http.user_agent",
        c.req.header("user-agent") || "unknown",
      );

      // Add request ID if it exists in headers
      const requestId = c.req.header("x-request-id");
      if (requestId) {
        span.setAttribute("http.request_id", requestId);
      }

      // Add custom attributes if configured
      if (config.additionalAttributes) {
        Object.entries(config.additionalAttributes).forEach(([key, value]) => {
          span.setAttribute(key, value);
        });
      }

      // Include request body if configured
      if (config.includeRequestBody) {
        try {
          const bodyClone = c.req.raw.clone();
          const body = await bodyClone.text();
          if (body) {
            span.setAttribute("http.request.body", body);
          }
        } catch (_) {
          /* swallow */
        }
      }

      try {
        // Execute the downstream handlers while this span is active
        await next();

        // Capture status code from response if available
        if (c.res?.status) {
          span.setAttribute("http.status_code", c.res.status);
        }

        // Include response body if configured
        if (config.includeResponseBody && c.res?.body) {
          try {
            const clonedResponse = c.res.clone();
            const text = await clonedResponse.text();
            if (text) {
              span.setAttribute("http.response.body", text);
            }
          } catch (_) {
            /* swallow */
          }
        }
      } catch (error) {
        span.setAttribute("error", true);
        span.setAttribute(
          "error.message",
          error instanceof Error ? error.message : String(error),
        );
        span.setAttribute(
          "error.type",
          error instanceof Error ? error.name : "UnknownError",
        );
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });

        if (error instanceof Error && error.stack) {
          span.setAttribute("error.stack", error.stack);
        }

        throw error;
      } finally {
        span.end();
      }
    });
  };
}

/**
 * Helper function to get the current span from context
 */
export function getCurrentSpan(): Span | undefined {
  return trace.getSpan(context.active());
}

/**
 * Helper function to create a child span and manage its lifecycle
 */
export async function createSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  attributes: Record<string, string | number | boolean> = {},
): Promise<T> {
  const parentSpan = getCurrentSpan();
  const span = obtainTracer().startSpan(
    name,
    undefined,
    parentSpan ? trace.setSpan(context.active(), parentSpan) : undefined,
  );

  // Add attributes
  Object.entries(attributes).forEach(([key, value]) => {
    span.setAttribute(key, value);
  });

  try {
    // Set the span as active for the duration of the function
    return await context.with(
      trace.setSpan(context.active(), span),
      async () => {
        const result = await fn(span);
        span.end();
        return result;
      },
    );
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    span.setAttribute("error", true);
    span.setAttribute(
      "error.message",
      error instanceof Error ? error.message : String(error),
    );
    span.end();
    throw error;
  }
}
