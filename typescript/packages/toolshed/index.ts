import app from "@/app.ts";
import env from "@/env.ts";

const port = env.PORT;
// eslint-disable-next-line no-console
console.log(`Server is running on port http://localhost:${port}`);

export type AppType = typeof app;

Deno.serve(app.fetch);
