import app from "@/app.ts";
import env from "@/env.ts";
import * as Sentry from "@sentry/deno";
const port = env.PORT;

console.log(`Server is running on port http://localhost:${port}`);

export type AppType = typeof app;

Sentry.init({
  dsn: env.SENTRY_DSN,
  tracesSampleRate: 1.0,
});

Deno.serve({ port }, app.fetch);
