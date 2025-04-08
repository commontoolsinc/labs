import { BackgroundCharmService } from "./service.ts";
import { getIdentity, log } from "./utils.ts";
import { env } from "./env.ts";

const identity = await getIdentity(env.IDENTITY, env.OPERATOR_PASS);
const service = new BackgroundCharmService({
  identity,
  toolshedUrl: env.TOOLSHED_API_URL,
});

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
