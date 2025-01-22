import app from "@/app.ts";
import env from "@/env.ts";

const port = env.PORT;

console.log(`Server is running on port http://localhost:${port}`);

export type AppType = typeof app;

Deno.serve(app.fetch);
