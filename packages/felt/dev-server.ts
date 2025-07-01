import { join } from "@std/path/join";
import { serveDir } from "@std/http/file-server";

const DEV_SOCKET = "DEV_SOCKET.js";

export class DevServer {
  private _server: Deno.HttpServer;
  private outDir: string;
  private sockets: WebSocket[] = [];
  private reloadableHtml: string;
  private socketScript: string;
  private useReloadSocket: boolean;

  constructor({ useReloadSocket, outDir, port, hostname }: {
    useReloadSocket: boolean;
    port: number;
    hostname: string;
    outDir: string;
  }) {
    this.useReloadSocket = useReloadSocket;
    this.outDir = outDir;
    this.reloadableHtml = this.getReloadableHtml({ outDir });
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

  private onRequest(req: Request) {
    const url = new URL(req.url);

    if (req.headers.get("upgrade") === "websocket") {
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

    if (this.useReloadSocket && url.pathname === "/") {
      return new Response(this.reloadableHtml, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }
    if (this.useReloadSocket && url.pathname === `/${DEV_SOCKET}`) {
      return new Response(this.socketScript, {
        status: 200,
        headers: { "Content-Type": "text/javascript" },
      });
    }

    return serveDir(req, {
      fsRoot: this.outDir,
      quiet: true,
    });
  }

  private getReloadableHtml({ outDir }: { outDir: string }): string {
    const html = Deno.readTextFileSync(join(outDir, "index.html"));
    return html.replace(
      "</body>",
      `<script src="/${DEV_SOCKET}" type="module"></script>\n</body>`,
    );
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
