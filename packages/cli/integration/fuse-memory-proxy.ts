const [upstreamText, tracePath] = Deno.args;
if (!upstreamText || !tracePath) {
  throw new Error("Usage: fuse-memory-proxy.ts <upstream-url> <trace-path>");
}

const upstreamBase = new URL(upstreamText);
Deno.writeTextFileSync(tracePath, "");

function upstreamUrl(request: Request): URL {
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

function proxyWebSocket(request: Request): Response {
  const { socket: downstream, response } = Deno.upgradeWebSocket(request);
  const address = upstreamUrl(request);
  address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
  const upstream = new WebSocket(address);
  const toUpstream: string[] = [];
  const toDownstream: string[] = [];

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
    if (typeof event.data !== "string") {
      closePeer(downstream, 1003, "memory websocket expects text frames");
      closePeer(upstream, 1003, "memory websocket expects text frames");
      return;
    }
    if (upstream.readyState === WebSocket.OPEN) upstream.send(event.data);
    else if (upstream.readyState === WebSocket.CONNECTING) {
      toUpstream.push(event.data);
    }
  });
  upstream.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      closePeer(downstream, 1003, "memory websocket expects text frames");
      closePeer(upstream, 1003, "memory websocket expects text frames");
      return;
    }
    Deno.writeTextFileSync(tracePath, `${event.data}\n`, { append: true });
    if (downstream.readyState === WebSocket.OPEN) downstream.send(event.data);
    else if (downstream.readyState === WebSocket.CONNECTING) {
      toDownstream.push(event.data);
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
}

async function proxyHttp(request: Request): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete("host");
  return await fetch(upstreamUrl(request), {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD"
      ? undefined
      : request.body,
    redirect: "manual",
  });
}

const server = Deno.serve({
  hostname: "127.0.0.1",
  port: 0,
  onListen: ({ hostname, port }) => {
    console.log(`http://${hostname}:${port}`);
  },
}, (request) => {
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return proxyWebSocket(request);
  }
  return proxyHttp(request);
});

await server.finished;
