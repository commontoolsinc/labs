import * as Memory from "./lib.ts";
import * as Path from "jsr:@std/path";

const url = new URL("./memory/", Path.toFileUrl(`${Deno.cwd()}/`));
const { ok: memory, error } = await Memory.open({ store: url });
if (error) {
  throw error;
}

Deno.serve((request: Request) => {
  if (request.headers.get("upgrade") != "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(request);
    memory.subscribe(socket);
    return response;
  } else if (request.method === "PATCH") {
    return memory.patch(request);
  } else {
    return new Response(null, { status: 501 });
  }
});
