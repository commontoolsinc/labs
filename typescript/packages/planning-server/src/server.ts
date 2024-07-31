import { CoreTool } from "npm:ai";
import { Application, Router } from "./deps.ts";
import { oakCors } from "./deps.ts";
import {
  handleAppendToConversationThread,
  handleCreateConversationThread,
} from "./actions.ts";
import { ModelName } from "./llm.ts";

type CreateConversationThreadRequest = {
  action: "create";
  message: string;
  system: string;
  activeTools: CoreTool[];
  model?: ModelName;
};

type AppendToConversationThreadRequest = {
  action: "append";
  threadId: string;
  message: string;
  model?: ModelName;
};

type ConversationThreadRequest =
  | CreateConversationThreadRequest
  | AppendToConversationThreadRequest;

export async function start() {
  const app = new Application();

  // Enabling CORS for port 5173 on localhost using oakCors
  // make sure to initialize oakCors before the routers
  app.use(
    oakCors({
      origin: "http://localhost:8081",
      optionsSuccessStatus: 200,
      methods: "POST, OPTIONS",
    })
  );

  const router = new Router();
  const handler = async (context) => {
    const request = context.request;
    if (request.method === "POST") {
      try {
        const body: ConversationThreadRequest = await request.body.json();
        const { action } = body;

        switch (action) {
          case "create": {
            const { message, system, activeTools, model } = body;
            const result = await handleCreateConversationThread(
              system,
              message,
              activeTools,
              model
            );
            context.response.status = 200;
            context.response.body = result;
            break;
          }
          case "append": {
            const { threadId, message, model } = body;
            const result = await handleAppendToConversationThread(
              threadId,
              message,
              model
            );
            context.response.status = 200;
            context.response.body = result;
            break;
          }
          default:
            context.response.status = 400;
            context.response.body = { error: "Invalid action" };
        }
      } catch (error) {
        context.response.status = 400;
        context.response.body = { error: error.message };
      }
    } else {
      context.response.status = 405;
      context.response.body = { error: "Method not allowed" };
    }
  };

  router.post("/", handler);
  router.post("/api/v0/llm", handler);

  app.use(router.routes());
  app.use(router.allowedMethods());

  const port = Number(Deno.env.get("PORT") || 8000);
  console.log(`Listening on port ${port}`);
  await app.listen({ port });
}
