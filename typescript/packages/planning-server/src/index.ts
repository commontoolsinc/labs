import { serve } from "https://deno.land/std@0.140.0/http/server.ts";
import { streamText } from "npm:ai";
import { ensureDir } from "https://deno.land/std/fs/mod.ts";
import { crypto } from "https://deno.land/std/crypto/mod.ts";
import { anthropic } from "npm:@ai-sdk/anthropic";
import { config } from "https://deno.land/x/dotenv/mod.ts";
await config({ export: true });

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
        stop?: string;
        stream: boolean; // LLM streams regardless, this is if we stream to the client
      };

      const description = JSON.stringify(payload.messages).slice(0, 80);

      const cacheKey = await hashKey(JSON.stringify(payload));
      const cachedResult = await loadCacheItem(cacheKey);
      if (cachedResult) {
        const lastMessage = cachedResult.messages[cachedResult.messages.length - 1];
        return new Response(JSON.stringify(lastMessage), {
          headers: { "Content-Type": "application/json" },
        });
      }

      console.log("Generating:", description);

      let messages = payload.messages;

      let params = {
        model: payload.model,
        system: payload.system,
        maxTokens: payload.max_tokens,
        messages,
      }

      const llmStream = await streamText({
        ...params,
        model: anthropic(payload.model),
        stopSequences: payload.stop ? [payload.stop] : undefined,
      });

      let result = "";

      if (messages[messages.length - 1].role === "assistant") {
        result = messages[messages.length - 1].content;
      }

      if (payload.stream) {
        const stream = new ReadableStream({
          async start(controller) {
            // NOTE: the llm doesn't send text we put into its mouth, so we need to
            // manually send it so that streaming client sees everything assistant 'said'
            if (messages[messages.length - 1].role === "assistant") {
              controller.enqueue(new TextEncoder().encode(JSON.stringify(result) + '\n'));
            }
            for await (const delta of llmStream.textStream) {
              result += delta;
              controller.enqueue(new TextEncoder().encode(JSON.stringify(delta) + '\n'));
            }

            if ((await llmStream.finishReason) === "stop" && payload.stop) {
              // NOTE(ja): we might have stopped because of a stop sequence, so add it to the result...
              // this is a hack that helps the client parse the result
              result += payload.stop;
              controller.enqueue(new TextEncoder().encode(JSON.stringify(payload.stop) + '\n'));
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

      for await (const delta of llmStream.textStream) {
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

      if ((await llmStream.finishReason) === "stop" && payload.stop) {
        result += payload.stop;
      }

      if (messages[messages.length - 1].role === "user") {
        messages.push({ role: "assistant", content: result });
      } else {
        messages[messages.length - 1].content = result;
      }

      await saveCacheItem(cacheKey, params);

      return new Response(JSON.stringify(params.messages[params.messages.length - 1]), {
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
    console.log(`Loading cache item: ${filePath}`);
    return JSON.parse(cacheData);
  } catch {
    return null;
  }
}

async function saveCacheItem(key: string, data: any): Promise<void> {
  const hash = await hashKey(key);
  const filePath = `${CACHE_DIR}/${hash}.json`;
  console.log(`Saving cache item: ${filePath}`);
  await ensureDir(CACHE_DIR);
  await Deno.writeTextFile(filePath, JSON.stringify(data, null, 2));
}

const port = Deno.env.get("PORT") || "8000";
console.log(`HTTP webserver running. Access it at: http://localhost:${port}/`);
await serve(handler, { port: parseInt(port) });
