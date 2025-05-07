import {
  context,
  Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "npm:@opentelemetry/api";

const tracer = trace.getTracer("common-memory", "1.0.0");

/**
 * Configuration for memory instrumentation.
 * Internal only, not exposed as part of the public API.
 */
export interface MemoryInstrumentationConfig {
  /** Whether instrumentation is enabled */
  enabled: boolean;
  /** Sampling rate (0-1) */
  samplingRate: number;
}

// Default configuration with instrumentation enabled
let config: MemoryInstrumentationConfig = {
  enabled: true,
  samplingRate: 1.0,
};

/**
 * Configure memory instrumentation.
 * Internal only, not exposed as part of the public API.
 */
export function configure(options: Partial<MemoryInstrumentationConfig>): void {
  config = { ...config, ...options };
}

/**
 * A non-invasive version of createSpan that guarantees it won't change
 * the control flow of the application by strictly maintaining the original
 * return types and values.
 *
 * This function creates a span and passes it to the callback, but ensures the
 * exact return value of the callback is preserved without modification.
 *
 * @param name - The name of the span
 * @param fn - Function that receives the span and returns a value
 * @param attributes - Optional initial attributes for the span
 * @returns The exact value returned by fn
 */
export function traceSync<T>(
  name: string,
  fn: (span: Span) => T,
  attributes: Record<string, string | number | boolean> = {},
): T {
  // Skip if telemetry is disabled or sampled out
  if (!config.enabled || Math.random() > config.samplingRate) {
    // Return the original function result without any span
    return fn({} as Span);
  }

  // Create and configure the span
  const span = tracer.startSpan(name, {
    kind: SpanKind.INTERNAL,
    attributes,
  });

  try {
    // Run the function with the span
    const result = fn(span);
    // End the span
    span.end();
    // Return the exact result
    return result;
  } catch (error) {
    // Record the error
    if (error instanceof Error) {
      span.recordException(error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
      });
    } else {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: String(error),
      });
    }
    // End the span
    span.end();
    // Re-throw the original error
    throw error;
  }
}

/**
 * A non-invasive version of createSpan for async functions that guarantees
 * it won't change the control flow of the application.
 *
 * @param name - The name of the span
 * @param fn - Async function that receives the span and returns a promise
 * @param attributes - Optional initial attributes for the span
 * @returns A promise that resolves to the exact value from fn
 */
export function traceAsync<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes: Record<string, string | number | boolean> = {},
): Promise<T> {
  // Skip if telemetry is disabled or sampled out
  if (!config.enabled || Math.random() > config.samplingRate) {
    // Return the original function result without any span
    return fn({} as Span);
  }

  // Create and configure the span
  const span = tracer.startSpan(name, {
    kind: SpanKind.INTERNAL,
    attributes,
  });

  // Execute the function with proper context propagation
  const activeContext = trace.setSpan(context.active(), span);

  return context.with(activeContext, async () => {
    try {
      // Run the function with the span
      const result = await fn(span);
      // End the span
      span.end();
      // Return the exact result
      return result;
    } catch (error) {
      // Record the error
      if (error instanceof Error) {
        span.recordException(error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message,
        });
      } else {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: String(error),
        });
      }
      // End the span
      span.end();
      // Re-throw the original error
      throw error;
    }
  });
}

/**
 * Add memory-specific attributes to a span.
 * This is a safe helper that doesn't modify behavior.
 */
export function addMemoryAttributes(
  span: Span | undefined,
  info: {
    operation?: string;
    space?: string;
    entity?: string;
    the?: string;
    cause?: string;
    changeCount?: number;
  },
): void {
  if (!span || !config.enabled) return;

  if (info.operation) span.setAttribute("memory.operation", info.operation);
  if (info.space) span.setAttribute("memory.space", info.space);
  if (info.entity) span.setAttribute("memory.entity", info.entity);
  if (info.the) span.setAttribute("memory.the", info.the);
  if (info.cause) span.setAttribute("memory.cause", info.cause);
  if (info.changeCount !== undefined) {
    span.setAttribute("memory.change_count", info.changeCount);
  }
}

/**
 * Records information about changes in a memory transaction.
 * This is a safe helper that doesn't modify behavior.
 */
export function addChangesAttributes(
  span: Span | undefined,
  changes: any,
): void {
  if (!span || !config.enabled || !changes) return;

  const entities = Object.keys(changes);
  const entityCount = entities.length;
  span.setAttribute("memory.changes.entity_count", entityCount);

  if (entityCount > 0 && entityCount <= 5) {
    // Limited entity info for small changes
    entities.forEach((entity, i) => {
      span.setAttribute(`memory.changes.entity.${i}`, entity);
    });
  }
}

/**
 * Records result information to a span.
 * This is a safe helper that doesn't modify the result.
 *
 * @returns the original result unchanged
 */
export function recordResult<T extends { error?: any; ok?: any }>(
  span: Span | undefined,
  result: T,
): T {
  if (!span || !config.enabled) return result;

  if (result.error) {
    span.setAttribute("memory.status", "error");
    span.setAttribute("memory.error.type", result.error.name || "unknown");
    if (result.error.message) {
      span.setAttribute("memory.error.message", result.error.message);
    }
    if (result.error.code) {
      span.setAttribute("memory.error.code", result.error.code);
    }

    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: result.error.message || "Error in memory operation",
    });
  } else {
    span.setAttribute("memory.status", "success");
    span.setStatus({ code: SpanStatusCode.OK });
  }

  // Always return the original unmodified result
  return result;
}
