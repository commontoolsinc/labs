import * as Provider from "./provider.ts";
import * as Socket from "./socket.ts";
import * as Path from "@std/path";
import * as UCAN from "./ucan.ts";
import * as Receipt from "./receipt.ts";

const storePath = (Deno.env.get("STORE") ?? "memory").replace(/\/?$/, "/");
const STORE = new URL(storePath, Path.toFileUrl(`${Deno.cwd()}/`));

const readInt = (value?: string) => {
  const n = parseInt(value ?? "");
  return isNaN(n) ? undefined : n;
};

const { ok: provider, error } = await Provider.open({
  store: STORE,
  rateLimiting: {
    baseThreshold: readInt(Deno.env.get("RATELIMIT_BASE_THRESHOLD")),
    requestLimit: readInt(Deno.env.get("RATELIMIT_REQUEST_LIMIT")),
    backoffFactor: readInt(Deno.env.get("RATELIMIT_BACKOFF_FACTOR")),
    maxDebounceCount: readInt(Deno.env.get("MAX_DEBOUNCE_COUNT")),
  },
});

if (error) {
  throw error;
}

Deno.serve({
  port: parseInt(Deno.env.get("PORT") ?? "8001"),
  hostname: Deno.env.get("HOST") ?? "0.0.0.0",
  onListen: ({ hostname, port }) => {
    console.log(`Mounting memory http://${hostname}:${port}/
from ${STORE}`);
  },
  handler: (request: Request) => {
    if (request.headers.get("upgrade") === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(request);
      const consumer = Socket.from<string, string>(socket);
      const session = provider.session();
      consumer
        .readable
        .pipeThrough(UCAN.fromStringStream())
        .pipeThrough(session)
        .pipeThrough(Receipt.toStringStream())
        .pipeTo(consumer.writable);
      return response;
    } else {
      return provider.fetch(request);
    }
  },
});
