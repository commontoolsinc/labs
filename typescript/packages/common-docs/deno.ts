import * as Memory from "./lib.ts";
import * as Path from "jsr:@std/path";

const url = new URL("./memory/", Path.toFileUrl(`${Deno.cwd()}/`));
const { ok: memory, error } = await Memory.open({ store: url });
if (error) {
  throw error;
}

Deno.serve((request) => {
  if (request.headers.get("upgrade") != "websocket") {
    return new Response(null, { status: 501 });
  }

  const { socket, response } = Deno.upgradeWebSocket(request);
  memory.subscribe(socket);

  return response;
});
