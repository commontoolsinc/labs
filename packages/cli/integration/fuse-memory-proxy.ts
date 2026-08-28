import {
  decodeCompressedMemoryMessage,
  isMemoryMessageFrame,
  type MemoryMessageFrame,
} from "@commonfabric/memory/v2/message-compression";

type RelayFrame = string | ArrayBuffer | Uint8Array<ArrayBuffer> | Blob;

export type FuseMemoryProxy = {
  server: Deno.HttpServer;
  /** Resolves after every received upstream frame has reached the trace. */
  idle(): Promise<void>;
};

function upstreamUrl(request: Request, upstreamBase: URL): URL {
  const incoming = new URL(request.url);
  return new URL(`${incoming.pathname}${incoming.search}`, upstreamBase);
}

function closePeer(peer: WebSocket, code: number, reason: string): void {
  if (
    peer.readyState === WebSocket.CONNECTING ||
    peer.readyState === WebSocket.OPEN
  ) {
    const forwardedCode = code === 1000 || code >= 3000 && code <= 4999
      ? code
      : 4000;
    peer.close(forwardedCode, reason);
  }
}

function relayFrame(frame: unknown): RelayFrame | null {
  if (!isMemoryMessageFrame(frame)) return null;
  return frame instanceof Uint8Array ? new Uint8Array(frame) : frame;
}

/** Starts the FUSE integration's HTTP and WebSocket relay. */
export function startFuseMemoryProxy(
  upstreamBase: URL,
  tracePath: string,
  onListen: (address: Deno.NetAddr) => void = () => {},
): FuseMemoryProxy {
  Deno.writeTextFileSync(tracePath, "");
  let traceWrites: Promise<void> = Promise.resolve();

  const proxyWebSocket = (request: Request): Response => {
    const { socket: downstream, response } = Deno.upgradeWebSocket(request);
    downstream.binaryType = "arraybuffer";
    const address = upstreamUrl(request, upstreamBase);
    address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
    const upstream = new WebSocket(address);
    upstream.binaryType = "arraybuffer";
    const toUpstream: RelayFrame[] = [];
    const toDownstream: RelayFrame[] = [];

    const appendTrace = (frame: MemoryMessageFrame): void => {
      traceWrites = traceWrites.then(async () => {
        const payload = await decodeCompressedMemoryMessage(frame);
        await Deno.writeTextFile(tracePath, `${payload}\n`, { append: true });
      });
      void traceWrites.catch((cause) => {
        console.error("memory websocket trace failed", cause);
        closePeer(downstream, 1011, "memory websocket trace failed");
        closePeer(upstream, 1011, "memory websocket trace failed");
      });
    };

    downstream.addEventListener("open", () => {
      for (const payload of toDownstream.splice(0)) downstream.send(payload);
    });
    upstream.addEventListener("open", () => {
      if (downstream.readyState >= WebSocket.CLOSING) {
        upstream.close();
        return;
      }
      for (const payload of toUpstream.splice(0)) upstream.send(payload);
    });

    downstream.addEventListener("message", (event) => {
      const frame = relayFrame(event.data);
      if (frame === null) {
        closePeer(downstream, 1003, "unsupported memory websocket frame");
        closePeer(upstream, 1003, "unsupported memory websocket frame");
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
      else if (upstream.readyState === WebSocket.CONNECTING) {
        toUpstream.push(frame);
      }
    });
    upstream.addEventListener("message", (event) => {
      const frame = relayFrame(event.data);
      if (frame === null) {
        closePeer(downstream, 1003, "unsupported memory websocket frame");
        closePeer(upstream, 1003, "unsupported memory websocket frame");
        return;
      }
      appendTrace(frame);
      if (downstream.readyState === WebSocket.OPEN) downstream.send(frame);
      else if (downstream.readyState === WebSocket.CONNECTING) {
        toDownstream.push(frame);
      }
    });

    downstream.addEventListener("close", (event) => {
      closePeer(upstream, event.code || 1000, event.reason);
    });
    upstream.addEventListener("close", (event) => {
      closePeer(downstream, event.code || 1000, event.reason);
    });
    downstream.addEventListener("error", () => {
      closePeer(upstream, 1011, "downstream websocket failed");
    });
    upstream.addEventListener("error", () => {
      closePeer(downstream, 1011, "upstream websocket failed");
    });

    return response;
  };

  const proxyHttp = async (request: Request): Promise<Response> => {
    const headers = new Headers(request.headers);
    headers.delete("host");
    return await fetch(upstreamUrl(request, upstreamBase), {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
      redirect: "manual",
    });
  };

  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen,
  }, (request) => {
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return proxyWebSocket(request);
    }
    return proxyHttp(request);
  });

  return {
    server,
    async idle() {
      await traceWrites;
    },
  };
}

if (import.meta.main) {
  const [upstreamText, tracePath] = Deno.args;
  if (!upstreamText || !tracePath) {
    throw new Error("Usage: fuse-memory-proxy.ts <upstream-url> <trace-path>");
  }
  const proxy = startFuseMemoryProxy(
    new URL(upstreamText),
    tracePath,
    ({ hostname, port }) => console.log(`http://${hostname}:${port}`),
  );
  await proxy.server.finished;
}
