import { serve } from "https://deno.land/std@0.140.0/http/server.ts";
import { generateText, streamText } from "npm:ai";
import { crypto } from "https://deno.land/std/crypto/mod.ts";
import { config } from "https://deno.land/x/dotenv/mod.ts";
import { ALIAS_NAMES, type Capabilities, findModel, MODELS } from "./models.ts";
import * as cache from "./cache.ts";
import { colors, timestamp, timeTrack } from "./cli.ts";

await config({ export: true });

const handler = async (request: Request): Promise<Response> => {
  const host = request.headers.get("host");
  const protocol = request.headers.get("x-forwarded-proto") || "http";
  const requestBaseURL = `${protocol}://${host}`;

  const startTime = Date.now();
  const requestId = colors.cyan + `[${crypto.randomUUID().slice(0, 8)}]` +
    colors.reset;

  if (request.method === "GET" && new URL(request.url).pathname === "/models") {
    const url = new URL(request.url);
    const search = url.searchParams.get("search")?.toLowerCase();
    const capabilities = url.searchParams.get("capability")?.split(",");

    const modelInfo = Object.entries(MODELS).reduce(
      (acc, [name, modelConfig]) => {
        // Skip aliases
        if (!ALIAS_NAMES.includes(name)) {
          // Apply name/provider search filter
          const nameMatches = !search || name.toLowerCase().includes(search);

          // Apply capability filters
          const capabilitiesMatch = !capabilities || capabilities.every(
            (cap) =>
              modelConfig
                .capabilities[cap as keyof typeof modelConfig.capabilities],
          );

          if (nameMatches && capabilitiesMatch) {
            acc[name] = {
              capabilities: modelConfig.capabilities,
              aliases: Object.entries(MODELS)
                .filter(([_, m]) => m === modelConfig && name !== _)
                .map(([alias]) => alias),
            };
          }
        }
        return acc;
      },
      {} as Record<
        string,
        { capabilities: Capabilities; aliases: string[] }
      >,
    );

    return new Response(JSON.stringify(modelInfo, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (request.method === "GET") {
    const indexRepsonse = {
      "GET": {
        "/models": `${requestBaseURL}/models`,
        "/models?search=anthropic": `${requestBaseURL}/models?search=anthropic`,
        "/models?capability=images":
          `${requestBaseURL}/models?capability=images`,
        "/models?search=groq&capability=images":
          `${requestBaseURL}/models?search=groq&capability=images`,
      },
      "POST": {
        "/": `${requestBaseURL}/`,
      },
    };
    return new Response(JSON.stringify(indexRepsonse, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
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
        abortSignal?: AbortSignal;
      };

      // Log request details with colors
      console.log(
        `${timestamp()} ${requestId} ${colors.blue}📝 New request:${colors.reset} ${colors.bright}${payload.model}\n${
          JSON.stringify(payload, null, 2)
        }${colors.reset} | ${timeTrack(startTime)}`,
      );

      console.log(
        `${timestamp()} ${requestId} ${colors.magenta}💭 System:${colors.reset} ${
          payload.system?.slice(0, 100)
        }...`,
      );

      const cacheKey = await cache.hashKey(JSON.stringify(payload));
      const cachedResult = await cache.loadItem(cacheKey);
      if (cachedResult) {
        console.log(
          `${timestamp()} ${requestId} ${colors.green}⚡️ Cache hit!${colors.reset} | ${
            timeTrack(startTime)
          }`,
        );
        const lastMessage =
          cachedResult.messages[cachedResult.messages.length - 1];
        return new Response(JSON.stringify(lastMessage), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const modelConfig = findModel(payload.model);
      if (!modelConfig) {
        console.warn(
          `${timestamp()} ${requestId} ${colors.yellow}⚠️  Unsupported model:${colors.reset} ${payload.model}`,
        );
        return new Response(
          JSON.stringify({
            error: `Unsupported model: ${payload.model}`,
            availableModels: Object.keys(MODELS),
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      console.log(
        `${timestamp()} ${requestId} ${colors.blue}🚀 Starting generation${colors.reset} | ${
          timeTrack(startTime)
        }`,
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
        abortSignal?: AbortSignal;
      };

      params = {
        ...params,
        system: payload.system,
        stopSequences: payload.stop ? [payload.stop] : undefined,
        abortSignal: request.signal,
      };

      // If the model doesn't support system prompts, we need to prepend the system
      // prompt to the first message.
      if (!modelConfig.capabilities.systemPrompt) {
        console.log(
          `${timestamp()} ${requestId} ${colors.yellow}🤔 LLM ${payload.model} doesn't support system prompts. Adding to first message.${colors.reset}`,
        );

        if (payload.system && messages.length > 0) {
          messages[0].content = `${payload.system}\n\n${messages[0].content}`;
          params.system = undefined;
        }
      }

      console.log(
        `${timestamp()} ${requestId} ${colors.blue}🎸 LLM Request Params:\n${colors.reset} ${
          JSON.stringify(params, null, 2)
        }`,
      );

      const llmStream = await streamText(params);

      let result = "";
      if (messages[messages.length - 1].role === "assistant") {
        result = messages[messages.length - 1].content;
      }

      let tokenCount = 0;

      if (payload.stream) {
        const stream = new ReadableStream({
          async start(controller) {
            // NOTE: the llm doesn't send text we put into its mouth, so we need to
            // manually send it so that streaming client sees everything assistant 'said'
            if (messages[messages.length - 1].role === "assistant") {
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify(result) + "\n"),
              );
            }
            for await (const delta of llmStream.textStream) {
              result += delta;
              tokenCount++;
              if (tokenCount % 100 === 0) {
                console.log(
                  `${timestamp()} ${requestId} ${colors.blue}📊 Generated${colors.reset} ${colors.bright}${tokenCount}${colors.reset} tokens | ${
                    timeTrack(startTime)
                  }`,
                );
              }
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify(delta) + "\n"),
              );
            }

            console.log(
              `${timestamp()} ${requestId} ${colors.green}✅ Stream complete:${colors.reset} ${colors.bright}${tokenCount}${colors.reset} tokens | ${
                timeTrack(startTime)
              }`,
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
            await cache.saveItem(cacheKey, params);
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
        `${timestamp()} ${requestId} ${colors.green}✅ Generation complete:${colors.reset} ${colors.bright}${tokenCount}${colors.reset} tokens | ${
          timeTrack(startTime)
        }`,
      );

      if (!result) {
        console.error(
          `${timestamp()} ${requestId} ${colors.red}❌ No response from LLM${colors.reset} | ${
            timeTrack(startTime)
          }`,
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

      await cache.saveItem(cacheKey, params);

      return new Response(
        JSON.stringify(params.messages[params.messages.length - 1]),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      console.error(
        `${timestamp()} ${requestId} ${colors.red}❌ Error: ${
          (error as Error).message
        }${colors.reset} | ${timeTrack(startTime)}`,
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

const port = Deno.env.get("PORT") || "8000";
console.log(`
${colors.bright}${colors.blue}🚀 Planning Server Ready${colors.reset}
${colors.cyan}🌍 http://localhost:${port}/${colors.reset}
${colors.yellow}📝 Cache directory: ${cache.CACHE_DIR}${colors.reset}
${colors.magenta}🤖 Available models: ${
  Object.keys(MODELS).join(", ")
}${colors.reset}
`);
await serve(handler, { port: parseInt(port) });
