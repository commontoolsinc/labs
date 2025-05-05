import { TestServer } from "./server.ts";
import { Manifest } from "./manifest.ts";
import { buildTestDir } from "./utils.ts";
import { Runner } from "./runner.ts";

// {*_,*.,}test.{ts, tsx, mts, js, mjs, jsx}
const manifest = await Manifest.create(Deno.cwd(), [...Deno.args]);
await buildTestDir(manifest);

const server = new TestServer(manifest);
server.start(manifest.requestedPort);
const port = server.port();

if (!port) {
  throw new Error(
    `Server could not listen on requested port ${manifest.requestedPort}.`,
  );
}

const runner = new Runner(manifest, port);
const success = await runner.run();

if (!success) {
  Deno.exit(1);
} else {
  Deno.exit(0);
}
