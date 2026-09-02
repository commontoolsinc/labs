import { serveDir } from "@std/http/file-server";
import { Manifest } from "./manifest.ts";

export class TestServer {
  #server: Deno.HttpServer<Deno.NetAddr> | null;
  #manifest: Manifest;

  // Takes the root dir of the current package `projectDir`,
  // and a directory to use as the root of the static
  // content server `serverDir`.
  constructor(manifest: Manifest) {
    this.#server = null;
    this.#manifest = manifest;
  }

  start(port: number) {
    this.#server = Deno.serve(
      { port, hostname: "127.0.0.1", onListen() {} },
      (req: Request) =>
        serveDir(req, {
          fsRoot: this.#manifest.serverDir,
          quiet: true,
          // A realm the test page creates -- a sandboxed iframe -- has an
          // opaque origin, and a module script is fetched in CORS mode, so
          // reaching a `bundle` entry from one takes this.
          enableCors: true,
        }),
    );
    if (!this.#server) throw new Error("Server creation failed");
    this.#server.unref();
  }

  // Returns the listening port, if server running.
  port(): number | undefined {
    return this.#server?.addr?.port;
  }

  async stop() {
    if (this.#server) {
      await this.#server.shutdown();
    }
  }
}
