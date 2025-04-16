import { pinoLogger as logger } from "hono-pino";
import { pino } from "pino";
import pretty from "pino-pretty";

import env from "@/env.ts";

export function pinoLogger() {
  return logger({
    pino: pino({
      level: env.LOG_LEVEL || "info",
      serializers: {
        res: (res) => {
          if (env.DISABLE_LOG_REQ_RES) {
            return undefined;
          }
          return {
            status: res.statusCode,
            headers: JSON.stringify(res.headers),
          };
        },
        req: (req) => {
          if (env.DISABLE_LOG_REQ_RES) {
            return undefined;
          }
          return {
            method: req.method,
            url: req.url,
            headers: env.ENV === "production"
              ? req.headers
              : JSON.stringify(req.headers),
          };
        },
      },
    }, env.ENV === "production" ? undefined : pretty()),
    http: {
      reqId: () => crypto.randomUUID(),
    },
  });
}
