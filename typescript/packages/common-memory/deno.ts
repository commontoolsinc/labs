import * as Memory from "./lib.ts";
import * as Path from "jsr:@std/path";

const storePath = (Deno.env.get("STORE") ?? "memory").replace(/\/?$/, '/');
const STORE = new URL(storePath, Path.toFileUrl(`${Deno.cwd()}/`));
const { ok: memory, error } = await Memory.open({
  store: STORE,
});

if (error) {
  throw error;
}

const server = Deno.serve({
  port: parseInt(Deno.env.get("PORT") ?? "8001"),
  hostname: Deno.env.get("HOST") ?? "0.0.0.0",
  onListen: ({ hostname, port }) => {
    console.log(`Mounting memory http://${hostname}:${port}/
from ${STORE}`);
  },
  handler: (request: Request) => {
    if (request.headers.get("upgrade") === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(request);
      memory.subscribe(socket);
      return response;
    } else if (request.method === "PATCH") {
      return memory.patch(request);
    } else if (request.method === "GET") {
      const url = new URL(request.url);
      return memory.get(request, url.pathname);
    } else {
      console.log("Not implemented", request.method, request.url);
      return new Response(null, { status: 501 });
    }
  },
});
