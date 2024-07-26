// deps.ts
export { default as datascript } from "npm:datascript";
import { config } from "https://deno.land/x/dotenv/mod.ts";
export { serve } from "https://deno.land/std@0.140.0/http/server.ts";
export { Application, Router } from "https://deno.land/x/oak/mod.ts";
export { oakCors } from "https://deno.land/x/cors/mod.ts";

export * as ai from "npm:ai";
export { anthropic } from "npm:@ai-sdk/anthropic";
export { google } from "npm:@ai-sdk/google";
import { createVertex } from "npm:@ai-sdk/google-vertex";

await config({ export: true });

const authOptions = {
  credentials: {
    client_email: Deno.env.get("GOOGLE_VERTEX_CLIENT_EMAIL")!,
    private_key: Deno.env
      .get("GOOGLE_VERTEX_PRIVATE_KEY")!
      .replace(/\\n/g, "\n"),
  },
};

export const vertex = createVertex({
  project: Deno.env.get("GOOGLE_VERTEX_PROJECT")!,
  location: Deno.env.get("GOOGLE_VERTEX_LOCATION")!,
  googleAuthOptions: authOptions,
});
