import { pinoLogger as logger } from "hono-pino";
import { pino } from "pino";
import pretty from "pino-pretty";

import env from "@/env.ts";

export function pinoLogger() {
  return logger({
    pino: pino({
      level: env.LOG_LEVEL || "info",
      serializers: {
        req: (req) => {
          // Log only minimal request info
          return {
            method: req.method,
            url: req.url,
            headers: env.ENV === "production"
              ? req.headers
              : JSON.stringify(req.headers),
            // Omit other details
          };
        },
      },
    }, env.ENV === "production" ? undefined : pretty()),
    http: {
      reqId: () => crypto.randomUUID(),
    },
  });
}
