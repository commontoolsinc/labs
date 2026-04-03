import * as Provider from "./provider.ts";
import * as Socket from "./socket.ts";
import * as Path from "@std/path";
import * as UCAN from "./ucan.ts";
import * as Receipt from "./receipt.ts";
import { type DID, Identity, isDID } from "@commontools/identity";

const serviceDid: DID = (() => {
  // Derived from passphrase "implicit trust"
  const FALLBACK_SERVICE_DID =
    "did:key:z6MksHnZGdHxNoCqcC3kPvBSo2goCzLSWheQ8LrVpAtQwgwW";
  const serviceDid: string = Deno.env.get("SERVICE_DID") ??
    FALLBACK_SERVICE_DID;
  if (!isDID(serviceDid)) {
    throw new Error("SERVICE_DID provided is an invalid DID.");
  }
  return serviceDid;
})();

const storePath = (Deno.env.get("STORE") ?? "memory").replace(/\/?$/, "/");
const STORE = new URL(storePath, Path.toFileUrl(`${Deno.cwd()}/`));
const { ok: provider, error } = await Provider.open({
  store: STORE,
  serviceDid,
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

export type Options = {
  store: URL;
  credentials?: { pkc8: Uint8Array; passphrase?: void } | {
    pkc8?: void;
    passphrase: string;
  };
  port?: number;
  host?: string;
};

export const open = async (
  {
    store,
    port = -1,
    host = "0.0.0.0",
    credentials = { passphrase: "implicit trust" },
  }: Options,
): Promise<Server> => {
  const identity = credentials.pkc8
    ? await Identity.fromPkcs8(credentials.pkc8)
    : await Identity.fromPassphrase(credentials.passphrase!);

  const { ok: provider, error } = await Provider.open({
    store,
    serviceDid: identity.did(),
  });

  if (error) {
    throw error;
  }

  return new Promise((resolve) => {
    const server = Deno.serve({
      port,
      hostname: host,
      onListen: (address) => {
        resolve(new Server(address, server));
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
  });
};

export class Server {
  constructor(public address: Deno.NetAddr, public server: Deno.HttpServer) {
  }
  get url() {
    return `http://${this.address.hostname}:${this.address.port}`;
  }

  close() {
    return this.server.shutdown();
  }
}
