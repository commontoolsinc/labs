import { serve } from "https://deno.land/std@0.140.0/http/server.ts";
import { streamText } from "npm:ai";
import { ensureDir } from "https://deno.land/std/fs/mod.ts";
import { crypto } from "https://deno.land/std/crypto/mod.ts";
import { anthropic } from "npm:@ai-sdk/anthropic";

const CACHE_DIR = "./cache";

const handler = async (request: Request): Promise<Response> => {
  if (request.method === "GET") {
    return new Response("Hello World");
  }

  if (request.method === "POST") {
    try {
      const payload = await request.json() as {
        messages: Array<{ role: string; content: string }>;
        system: string;
        model: string;
        max_tokens: number;
        stream: boolean; // LLM streams regardless, this is if we stream to the client
      };

      const description = JSON.stringify(payload.messages).slice(0, 80);

      const cacheKey = await hashKey(JSON.stringify(payload));
      const cachedResult = await loadCacheItem(cacheKey);
      if (cachedResult) {
        console.log("Cache hit:", description);
        return new Response(JSON.stringify(cachedResult), {
          headers: { "Content-Type": "application/json" },
        });
      }

      console.log("Cache miss:", description);

      let messages = payload.messages;

      let params = {
        model: payload.model,
        system: payload.system,
        messages,
      }

      const { textStream } = await streamText({
        ...params,
        model: anthropic(payload.model)
      });

      let result = "";

      if (messages[messages.length - 1].role === "assistant") {
        result = messages[messages.length - 1].content;
      }

      if (payload.stream) {
        const stream = new ReadableStream({
          async start(controller) {
            if (messages[messages.length - 1].role === "assistant") {
              controller.enqueue(new TextEncoder().encode(result + '\n'));
            }
            for await (const delta of textStream) {
              result += delta;
              controller.enqueue(new TextEncoder().encode(delta + '\n'));
            }

            if (messages[messages.length - 1].role === "user") {
              messages.push({ role: "assistant", content: result });
            } else {
              messages[messages.length - 1].content = result;
            }
            await saveCacheItem(cacheKey, params); // after finishing, save!
            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Transfer-Encoding": "chunked"
          },
        });
      }

      for await (const delta of textStream) {
        result += delta;
      }

      if (!result) {
        return new Response(
          JSON.stringify({ error: "No response from LLM" }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      if (messages[messages.length - 1].role === "user") {
        messages.push({ role: "assistant", content: result });
      } else {
        messages[messages.length - 1].content = result;
      }

      await saveCacheItem(cacheKey, params);

      return new Response(JSON.stringify(params), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: (error as Error).message }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
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
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function loadCacheItem(key: string): Promise<any | null> {
  const hash = await hashKey(key);
  const filePath = `${CACHE_DIR}/${hash}.json`;
  try {
    await ensureDir(CACHE_DIR);
    const cacheData = await Deno.readTextFile(filePath);
    return JSON.parse(cacheData);
  } catch {
    return null;
  }
}

async function saveCacheItem(key: string, data: any): Promise<void> {
  const hash = await hashKey(key);
  const filePath = `${CACHE_DIR}/${hash}.json`;
  await ensureDir(CACHE_DIR);
  await Deno.writeTextFile(filePath, JSON.stringify(data, null, 2));
}

const port = Deno.env.get("PORT") || "8000";
console.log(`HTTP webserver running. Access it at: http://localhost:${port}/`);
await serve(handler, { port: parseInt(port) });
