import { Identity } from "@commontools/identity";
import { encode } from "@commontools/utils/encoding";

/**
 * Usage:
 * `deno task key-did KEY_PATH`
 */

async function main() {
  const keyFilePath = Deno.args[0];
  if (!keyFilePath) {
    throw new Error("No KEY_PATH argument provided.");
  }
  const keyBuffer = await Deno.readFile(keyFilePath);
  const identity = await Identity.fromPkcs8(keyBuffer);
  await Deno.stdout.write(encode(identity.did()));
}

if (import.meta.main) {
  main();
}
