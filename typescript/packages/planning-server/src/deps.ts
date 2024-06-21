// deps.ts
export { default as datascript } from "npm:datascript";
export { default as Anthropic } from "npm:@anthropic-ai/sdk";
import { config } from "https://deno.land/x/dotenv/mod.ts";
export { serve } from "https://deno.land/std@0.140.0/http/server.ts";

await config({ export: true });
