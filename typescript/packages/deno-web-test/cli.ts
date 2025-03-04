import { parseArgs } from "jsr:@std/cli/parse-args";
import { TestServer } from "./server.ts";
import { Manifest } from "./manifest.ts";
import { buildTestDir } from "./utils.ts";
import { Runner } from "./runner.ts";

// {*_,*.,}test.{ts, tsx, mts, js, mjs, jsx}
const manifest = await Manifest.create(Deno.cwd(), [...Deno.args]);
await buildTestDir(manifest);

const server = new TestServer(manifest);
server.start(manifest.port);

const runner = new Runner(manifest);
const success = await runner.run();

if (!success) {
  Deno.exit(1);
} else {
  Deno.exit(0);
}
