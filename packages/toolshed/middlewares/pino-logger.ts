import { pinoLogger as logger } from "hono-pino";
import { pino } from "pino";
import pretty from "pino-pretty";

import env from "@/env.ts";

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
]);

export function redactHeaders(headers: unknown): unknown {
  if (headers instanceof Headers) {
    return Object.fromEntries(
      [...headers.entries()].map(([name, value]) => [
        name,
        SENSITIVE_HEADERS.has(name.toLowerCase()) ? "[redacted]" : value,
      ]),
    );
  }
  if (
    headers === null || typeof headers !== "object" || Array.isArray(headers)
  ) {
    return headers;
  }
  return Object.fromEntries(
    Object.entries(headers as Record<string, unknown>).map(([name, value]) => [
      name,
      SENSITIVE_HEADERS.has(name.toLowerCase()) ? "[redacted]" : value,
    ]),
  );
}

export function serializeResponse(response: {
  statusCode: number;
  headers: unknown;
}): { status: number; headers: string } | undefined {
  if (env.DISABLE_LOG_REQ_RES) {
    return undefined;
  }
  return {
    status: response.statusCode,
    headers: JSON.stringify(redactHeaders(response.headers)),
  };
}

export function pinoLogger() {
  return logger({
    pino: pino({
      level: env.LOG_LEVEL || "info",
      serializers: {
        res: serializeResponse,
        req: (req) => {
          if (env.DISABLE_LOG_REQ_RES) {
            return undefined;
          }
          return {
            method: req.method,
            url: req.url,
            headers: env.ENV === "production"
              ? redactHeaders(req.headers)
              : JSON.stringify(redactHeaders(req.headers)),
          };
        },
      },
    }, env.ENV === "production" ? undefined : pretty()),
    http: {
      reqId: () => crypto.randomUUID(),
    },
  });
}
