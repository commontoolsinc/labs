// deps.ts
export { default as datascript } from "npm:datascript";
import { config } from "https://deno.land/x/dotenv/mod.ts";
export { serve } from "https://deno.land/std@0.140.0/http/server.ts";

export * as ai from "npm:ai";
export { anthropic } from "npm:@ai-sdk/anthropic";

await config({ export: true });
