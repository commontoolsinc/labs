import { DevServer } from "./dev-server.ts";
import { Builder } from "./builder.ts";
import { FeltCommand, ResolvedConfig } from "./interface.ts";
import { copy } from "@std/fs";

export class Felt {
  constructor(
    public command: FeltCommand,
    public config: ResolvedConfig,
  ) {}

  async process() {
    const { port, hostname, watchDir, publicDir, outDir } = this.config;
    const isBuild = this.command === "build";
    const isServe = this.command === "serve";
    const isDev = this.command === "dev";

    if (isServe || isDev) {
      console.log(`Serving: ${this.config.publicDir}`);
      console.log(`Listening on: http://${hostname}:${port}`);
      if (isDev) {
        console.log(`Watching for changes at: ${watchDir}`);
      }
    }

    await copy(publicDir, outDir, { overwrite: true });

    const builder = new Builder(this.config);
    await builder.build();

    if (isBuild) {
      return;
    }

    const server = new DevServer({
      useReloadSocket: isDev,
      hostname,
      port,
      outDir,
    });

    if (isDev) {
      builder.addEventListener("build", (_) => {
        server.reload();
      });
      await builder.watch(watchDir);
    }
  }
}
