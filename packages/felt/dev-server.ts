import { join } from "@std/path/join";
import { serveDir } from "@std/http/file-server";

const DEV_SOCKET = "DEV_SOCKET.js";

export class DevServer {
  private _server: Deno.HttpServer;
  private outDir: string;
  private sockets: WebSocket[] = [];
  private html: string;
  private socketScript: string;
  private useReloadSocket: boolean;
  private redirectToIndex?: RegExp;
  private staticDirs: Array<{ from: string; to: string }>;

  constructor({ useReloadSocket, outDir, port, hostname, redirectToIndex, staticDirs = [] }: {
    useReloadSocket: boolean;
    port: number;
    hostname: string;
    outDir: string;
    redirectToIndex?: RegExp;
    staticDirs?: Array<{ from: string; to: string }>;
  }) {
    this.useReloadSocket = useReloadSocket;
    this.outDir = outDir;
    this.redirectToIndex = redirectToIndex;
    this.staticDirs = staticDirs;
    this.html = this.getHtml({ useReloadSocket, outDir });
    this.socketScript = this.getSocketScript({ hostname, port });
    this._server = Deno.serve(
      { port, hostname, onListen() {} },
      this.onRequest.bind(this),
    );
  }

  reload() {
    for (const socket of this.sockets) {
      socket.send("reload");
    }
  }

  private async onRequest(req: Request) {
    const url = new URL(req.url);

    if (req.headers.get("upgrade") === "websocket") {
      return this.upgradeWebSocket(req);
    }

    if (this.useReloadSocket && url.pathname === `/${DEV_SOCKET}`) {
      return new Response(this.socketScript, {
        status: 200,
        headers: { "Content-Type": "text/javascript" },
      });
    }

    if (
      url.pathname === "/" || url.pathname === "/index.html" ||
      (this.redirectToIndex && this.redirectToIndex?.test(url.pathname))
    ) {
      return new Response(this.html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }

    // Check static directories
    for (const { from, to } of this.staticDirs) {
      if (url.pathname.startsWith(to)) {
        // Handle OPTIONS requests for CORS
        if (req.method === "OPTIONS") {
          return new Response(null, {
            status: 204,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, OPTIONS, HEAD",
              "Access-Control-Allow-Headers": "*",
            },
          });
        }
        
        // Create a new request with the path adjusted to remove the URL prefix
        const relativePath = url.pathname.slice(to.length);
        const adjustedUrl = new URL(req.url);
        adjustedUrl.pathname = relativePath || "/";
        const adjustedReq = new Request(adjustedUrl, req);
        
        const response = await serveDir(adjustedReq, {
          fsRoot: from,
          quiet: true,
        });
        
        // Add CORS headers for all responses
        response.headers.set("Access-Control-Allow-Origin", "*");
        response.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS, HEAD");
        response.headers.set("Access-Control-Allow-Headers", "*");
        
        return response;
      }
    }

    return serveDir(req, {
      fsRoot: this.outDir,
      quiet: true,
    });
  }

  private upgradeWebSocket(req: Request): Response {
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.addEventListener("open", () => {
      this.sockets.push(socket);
    });
    socket.addEventListener("close", () => {
      const index = this.sockets.findIndex((s) => s === socket);
      if (index > 0) {
        this.sockets.splice(index, 1);
      }
    });
    return response;
  }

  private getHtml(
    { useReloadSocket, outDir }: { useReloadSocket?: boolean; outDir: string },
  ): string {
    const html = Deno.readTextFileSync(join(outDir, "index.html"));
    return useReloadSocket
      ? html.replace(
        "</body>",
        `<script src="/${DEV_SOCKET}" type="module"></script>\n</body>`,
      )
      : html;
  }

  private getSocketScript(
    { hostname, port }: { hostname: string; port: number },
  ): string {
    let script = "";
    script += devSocketClient.toString();
    script += `\ndevSocketClient({ port: ${port}, hostname: "${hostname}" });`;
    return script;
  }
}

// This function gets serialized and served as `/${DEV_SOCKET}` in the client
function devSocketClient(
  { hostname, port }: { hostname: string; port: number },
) {
  const socket = new WebSocket(`ws://${hostname}:${port}`);
  socket.addEventListener("open", (event) => {
    socket.addEventListener("message", (event) => {
      if (event.data === "reload") {
        globalThis.location.reload();
      }
    });
  });
}
