import { serve } from "https://deno.land/std@0.140.0/http/server.ts";
import { streamText, generateText } from "npm:ai";
import { ensureDir } from "https://deno.land/std/fs/mod.ts";
import { crypto } from "https://deno.land/std/crypto/mod.ts";
import { anthropic } from "npm:@ai-sdk/anthropic";
import { config } from "https://deno.land/x/dotenv/mod.ts";
import { groq } from "npm:@ai-sdk/groq";
import { openai } from "npm:@ai-sdk/openai";
import { vertex } from "npm:@ai-sdk/google-vertex";

await config({ export: true });

const CACHE_DIR = "./cache";

const MODELS: Record<
  string,
  { model: any; contextWindow: number; maxOutputTokens: number }
> = {
  "anthropic:claude-3.5-haiku": {
    model: anthropic("claude-3-5-haiku-20241022"),
    contextWindow: 200000,
    maxOutputTokens: 8192,
  },
  "anthropic:claude-3.5-sonnet": {
    model: anthropic("claude-3-5-sonnet-20241022"),
    contextWindow: 200000,
    maxOutputTokens: 8192,
  },
  "anthropic:claude-3-opus": {
    model: anthropic("claude-3-opus-20240229"),
    contextWindow: 200000,
    maxOutputTokens: 4096,
  },
  "groq:llama-3.1-70b": {
    model: groq("llama-3.1-70b-versatile"),
    contextWindow: 128000,
    maxOutputTokens: 8000,
  },
  "groq:llama-3.2-11b-vision": {
    model: groq("llama-3.2-11b-vision-preview"),
    contextWindow: 128000,
    maxOutputTokens: 8000,
  },
  "groq:llama-3.2-90b-vision": {
    model: groq("llama-3.2-90b-vision-preview"),
    contextWindow: 128000,
    maxOutputTokens: 8000,
  },
  "openai:gpt-4o": {
    // TODO
    model: openai("gpt-4o"),
    contextWindow: 128000,
    maxOutputTokens: 16384,
  },
  "openai:gpt-4o-mini": {
    // TODO
    model: openai("gpt-4o-mini"),
    contextWindow: 128000,
    maxOutputTokens: 16384,
  },
  "openai:o1-preview": {
    // TODO
    model: openai("o1-preview-2024-09-12"),
    contextWindow: 128000,
    maxOutputTokens: 32768,
  },
  "openai:o1-mini": {
    // TODO
    model: openai("o1-mini-2024-09-12"),
    contextWindow: 128000,
    maxOutputTokens: 65536,
  },
  "google:gemini-1.5-flash": {
    model: vertex("gemini-1.5-flash-002"),
    contextWindow: 1000000,
    maxOutputTokens: 8192,
  },
  "google:gemini-1.5-pro": {
    model: vertex("gemini-1.5-pro-002"),
    contextWindow: 1000000,
    maxOutputTokens: 8192,
  },
};

// Add color utility functions at the top
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

// Helper for timestamps
const timestamp = () =>
  colors.dim + new Date().toLocaleTimeString() + colors.reset;
const timeTrack = (start: number) =>
  colors.gray + `${(Date.now() - start).toFixed(0)}ms` + colors.reset;

const handler = async (request: Request): Promise<Response> => {
  const startTime = Date.now();
  const requestId =
    colors.cyan + `[${crypto.randomUUID().slice(0, 8)}]` + colors.reset;

  if (request.method === "GET") {
    return new Response("Hello World");
  }

  if (request.method === "POST") {
    try {
      const payload = (await request.json()) as {
        messages: Array<{ role: string; content: string }>;
        system?: string;
        model: string;
        max_tokens: number;
        stop?: string;
        stream: boolean;
        max_completion_tokens?: number;
      };

      // Log request details with colors
      console.log(
        `${timestamp()} ${requestId} ${colors.blue}📝 New request:${colors.reset} ${colors.bright}${payload.model}${colors.reset} | ${timeTrack(startTime)}`,
      );
      console.log(
        `${timestamp()} ${requestId} ${colors.magenta}💭 System:${colors.reset} ${payload.system?.slice(0, 100)}...`,
      );
      console.log(
        `${timestamp()} ${requestId} ${colors.yellow}💬 Last message:${colors.reset} ${payload.messages[payload.messages.length - 1].content.slice(0, 100)}...`,
      );

      const cacheKey = await hashKey(JSON.stringify(payload));
      const cachedResult = await loadCacheItem(cacheKey);
      if (cachedResult) {
        console.log(
          `${timestamp()} ${requestId} ${colors.green}⚡️ Cache hit!${colors.reset} | ${timeTrack(startTime)}`,
        );
        const lastMessage =
          cachedResult.messages[cachedResult.messages.length - 1];
        return new Response(JSON.stringify(lastMessage), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const modelConfig = MODELS[payload.model];
      if (!modelConfig) {
        console.warn(
          `${timestamp()} ${requestId} ${colors.yellow}⚠️  Unsupported model:${colors.reset} ${payload.model}`,
        );
      }

      console.log(
        `${timestamp()} ${requestId} ${colors.blue}🚀 Starting generation${colors.reset} | ${timeTrack(startTime)}`,
      );

      let messages = payload.messages;

      let params = {
        model: modelConfig.model || payload.model,
        messages,
        stream: payload.stream,
      } as {
        model: any;
        messages: Array<{ role: string; content: string }>;
        stream: boolean;
        system?: string;
        stopSequences?: string[];
      };

      // NOTE(jake): Unfortunately the o1 model is a unique snowflake, and requires
      // a distinctly different request payload than the other models..
      //
      // We can't send a system prompt, stop sequences, or max_tokens.
      if (payload.model?.startsWith("openai:o1")) {
        if (payload.system && messages.length > 0) {
          messages[0].content = `${payload.system}\n\n${messages[0].content}`;
        }
      } else {
        params = {
          ...params,
          system: payload.system,
          stopSequences: payload.stop ? [payload.stop] : undefined,
        };
      }

      const llmStream = await streamText(params);

      let result = "";
      let tokenCount = 0;

      if (payload.stream) {
        const stream = new ReadableStream({
          async start(controller) {
            for await (const delta of llmStream.textStream) {
              result += delta;
              tokenCount++;
              if (tokenCount % 100 === 0) {
                console.log(
                  `${timestamp()} ${requestId} ${colors.blue}📊 Generated${colors.reset} ${colors.bright}${tokenCount}${colors.reset} tokens | ${timeTrack(startTime)}`,
                );
              }
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify(delta) + "\n"),
              );
            }

            console.log(
              `${timestamp()} ${requestId} ${colors.green}✅ Stream complete:${colors.reset} ${colors.bright}${tokenCount}${colors.reset} tokens | ${timeTrack(startTime)}`,
            );

            if ((await llmStream.finishReason) === "stop" && payload.stop) {
              result += payload.stop;
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify(payload.stop) + "\n"),
              );
            }

            if (messages[messages.length - 1].role === "user") {
              messages.push({ role: "assistant", content: result });
            } else {
              messages[messages.length - 1].content = result;
            }
            await saveCacheItem(cacheKey, params);
            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Transfer-Encoding": "chunked",
          },
        });
      }

      for await (const delta of llmStream.textStream) {
        result += delta;
        tokenCount++;
      }

      console.log(
        `${timestamp()} ${requestId} ${colors.green}✅ Generation complete:${colors.reset} ${colors.bright}${tokenCount}${colors.reset} tokens | ${timeTrack(startTime)}`,
      );

      if (!result) {
        console.error(
          `${timestamp()} ${requestId} ${colors.red}❌ No response from LLM${colors.reset} | ${timeTrack(startTime)}`,
        );
        return new Response(JSON.stringify({ error: "No response from LLM" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

      if ((await llmStream.finishReason) === "stop" && payload.stop) {
        result += payload.stop;
      }

      if (messages[messages.length - 1].role === "user") {
        messages.push({ role: "assistant", content: result });
      } else {
        messages[messages.length - 1].content = result;
      }

      await saveCacheItem(cacheKey, params);

      return new Response(
        JSON.stringify(params.messages[params.messages.length - 1]),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      console.error(
        `${timestamp()} ${requestId} ${colors.red}❌ Error: ${(error as Error).message}${colors.reset} | ${timeTrack(startTime)}`,
      );
      return new Response(JSON.stringify({ error: (error as Error).message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  } else {
    return new Response("Please send a POST request", { status: 405 });
  }
};

async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadCacheItem(key: string): Promise<any | null> {
  const hash = await hashKey(key);
  const filePath = `${CACHE_DIR}/${hash}.json`;
  try {
    const cacheData = await Deno.readTextFile(filePath);
    console.log(
      `${timestamp()} ${colors.green}📦 Cache loaded:${colors.reset} ${filePath.slice(-12)}`,
    );
    return JSON.parse(cacheData);
  } catch {
    return null;
  }
}

async function saveCacheItem(key: string, data: any): Promise<void> {
  const hash = await hashKey(key);
  const filePath = `${CACHE_DIR}/${hash}.json`;
  console.log(
    `${timestamp()} ${colors.green}💾 Cache saved:${colors.reset} ${filePath}`,
  );
  await ensureDir(CACHE_DIR);
  await Deno.writeTextFile(filePath, JSON.stringify(data, null, 2));
}

const port = Deno.env.get("PORT") || "8000";
console.log(`
${colors.bright}${colors.blue}🚀 Planning Server Ready${colors.reset}
${colors.cyan}🌍 http://localhost:${port}/${colors.reset}
${colors.yellow}📝 Cache directory: ${CACHE_DIR}${colors.reset}
${colors.magenta}🤖 Available models: ${Object.keys(MODELS).join(", ")}${colors.reset}
`);
await serve(handler, { port: parseInt(port) });
