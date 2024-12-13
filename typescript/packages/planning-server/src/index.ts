import { serve } from "https://deno.land/std@0.140.0/http/server.ts";
import { generateText, streamText } from "npm:ai";
import { crypto } from "https://deno.land/std/crypto/mod.ts";
import { config } from "https://deno.land/x/dotenv/mod.ts";
import {
  ALIAS_NAMES,
  type Capabilities,
  findModel,
  MODELS,
  TASK_MODELS,
  TaskType,
} from "./models.ts";
import * as cache from "./cache.ts";
import { colors, timestamp, timeTrack } from "./cli.ts";
import { register as registerPhoenixOtel } from "./instrumentation.ts";

registerPhoenixOtel();

await config({ export: true });

const handleGetIndex = async (request: Request): Promise<Response> => {
  const host = request.headers.get("host");
  const protocol = request.headers.get("x-forwarded-proto") || "http";
  const requestBaseURL = `${protocol}://${host}`;

  const indexRepsonse = {
    "GET": {
      "list all models": `${requestBaseURL}/models`,
      "list models by provider": `${requestBaseURL}/models?search=anthropic`,
      "list models by capability": `${requestBaseURL}/models?capability=images`,
      "list models by provider and capability":
        `${requestBaseURL}/models?search=groq&capability=images`,
      "list models by task (coding)": `${requestBaseURL}/models?task=coding`,
      "list models by task (creative)":
        `${requestBaseURL}/models?task=creative`,
      "list models by task (vision)": `${requestBaseURL}/models?task=vision`,
    },
    "POST": {
      "generate text": `${requestBaseURL}/`,
    },
  };
  return new Response(JSON.stringify(indexRepsonse, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
};

const handleGetModels = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.toLowerCase();
  const capabilities = url.searchParams.get("capability")?.split(",");
  const task = url.searchParams.get("task") as TaskType | undefined;

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

        // Apply task filter
        const taskMatches = !task || TASK_MODELS[task] === name;

        if (nameMatches && capabilitiesMatch && taskMatches) {
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
};

const handleLLMPost = async (request: Request): Promise<Response> => {
  const startTime = Date.now();
  const requestId = colors.cyan + `[${crypto.randomUUID().slice(0, 8)}]` +
    colors.reset;

  try {
    const payload = (await request.json()) as {
      messages: Array<{ role: string; content: string }>;
      system?: string;
      model?: string;
      task?: TaskType;
      max_tokens: number;
      stop?: string;
      stream: boolean;
      max_completion_tokens?: number;
      abortSignal?: AbortSignal;
    };

    if (!payload.model && !payload.task) {
      return new Response(
        JSON.stringify({ error: "You must specify a `model` or `task`." }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // NOTE: This is a sketch of a higher-level hueristic model selection, based on the task you're trying to accomplish.
    if (payload.task) {
      const taskModel = TASK_MODELS[payload.task];
      if (!taskModel) {
        console.warn(
          `${timestamp()} ${requestId} ${colors.yellow}⚠️  Unsupported task:${colors.reset} ${payload.task}`,
        );
        return new Response(
          JSON.stringify({
            error: `Unsupported task: ${payload.task}`,
            availableTasks: Object.keys(TASK_MODELS),
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      payload.model = taskModel;
      console.log(
        `${timestamp()} ${requestId} ${colors.blue}🎯 Task ${colors.bright}${payload.task}${colors.reset} mapped to model ${colors.bright}${taskModel}${colors.reset}`,
      );
    }

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

    // FIXME(jake): revisit the payload hashing, we maybe want just the model and prompt?
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
      experimental_telemetry?: {
        isEnabled: boolean;
      };
    };

    params = {
      ...params,
      system: payload.system,
      stopSequences: payload.stop ? [payload.stop] : undefined,
      abortSignal: request.signal,
      experimental_telemetry: {
        isEnabled: true,
      },
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
          "CT-Task-Selected-Model": modelConfig.model.modelId,
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
        headers: {
          "Content-Type": "application/json",
          "CT-Task-Selected-Model": modelConfig.model.modelId,
        },
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
};

const handler = async (request: Request): Promise<Response> => {
  if (request.method === "GET") {
    switch (new URL(request.url).pathname) {
      case "/":
        return handleGetIndex(request);
      case "/models":
        return handleGetModels(request);
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  if (request.method === "POST") {
    switch (new URL(request.url).pathname) {
      case "/":
        return handleLLMPost(request);
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  return new Response("Not found", { status: 404 });
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
