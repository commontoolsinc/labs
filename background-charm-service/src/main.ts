import { BackgroundCharmService } from "./service.ts";
import { log } from "./utils.ts";

const service = new BackgroundCharmService();

const shutdown = () => {
  // @ts-ignore: Object is possibly 'undefined'
  service.stop().then(() => {
    Deno.exit(0);
  });
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

service.initialize().then(() => {
  log("Background Charm Service started successfully");
  log("Press Ctrl+C to stop");
});
