import { ask } from "./anthropic.ts";
import { Anthropic, serve } from "./deps.ts";

const handler = async (request: Request): Promise<Response> => {
  if (request.method === "POST") {
    try {
      const body = await request.json();
      const spell = body.spell || [];
      const system = body.system || "";
      const activeTools = body.activeTools || [];

      let bigConversation: Anthropic.Messages.MessageParam[] = [];

      for (const s of spell) {
        console.log("Incantation", s);
        const result = await ask(
          [
            ...bigConversation,
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: s,
                },
              ],
            },
          ],
          system,
          activeTools
        );
        if (!result) {
          return new Response(
            JSON.stringify({ error: "No response from Anthropic" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
        bigConversation = [...bigConversation, ...result];
      }

      const last = bigConversation[bigConversation.length - 1];
      const output = (last.content as any[]).map((msg) => msg.text);

      return new Response(JSON.stringify({ output }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  } else {
    return new Response("Please send a POST request", { status: 405 });
  }
};

const port = Deno.env.get("PORT") || "8000";
console.log(`HTTP webserver running. Access it at: http://localhost:${port}/`);
await serve(handler, { port: parseInt(port) });
