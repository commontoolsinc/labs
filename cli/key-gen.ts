import { Identity } from "@commontools/identity";

/**
 * Usage:
 * `deno task key-gen > key.ed25519`
 */

async function main() {
  const pkcs8Material = await Identity.generatePkcs8();
  await Deno.stdout.write(pkcs8Material);
}

if (import.meta.main) {
  main();
}
