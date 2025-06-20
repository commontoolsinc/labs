import { Command } from "@cliffy/command";
import { render } from "../lib/render.ts";
import {
  getDidFromFile,
  pkcs8FromEntropy,
  pkcs8FromPassphrase,
} from "../lib/identity.ts";

export const identity = new Command()
  .name("id")
  .description("Interact with common identites.")
  .default("help")
  /* id new */
  .command("new", "Output a new identity keyfile to stdout.")
  .example("ct id create > ./my.key", "Create and store a keyfile at ./my.key")
  .action(createIdentity)
  /* id did */
  .command("did <keypath:string>", "Output the DID of a keyfile to stdout.")
  .example("ct id did ./my.key", "Outputs the DID of ./my.key to stdout.")
  .action(getDid)
  /* id derive */
  .command("derive", "Derives a keyfile from the provided passphrase.")
  .example(
    'ct id derive "common user" > ./my.key',
    'Create and store a keyfile at ./my.key derived from the string "common user".',
  )
  .arguments("<passphrase:string>")
  .action(deriveIdentity);

async function createIdentity() {
  const pkcs8Material = await pkcs8FromEntropy();
  render(pkcs8Material);
}

async function getDid(_: void, keypath: string) {
  const did = await getDidFromFile(keypath);
  render(did);
}

async function deriveIdentity(_: void, passphrase: string) {
  const pkcs8Material = await pkcs8FromPassphrase(passphrase);
  render(pkcs8Material);
}
