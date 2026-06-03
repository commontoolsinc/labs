import { Command } from "@cliffy/command";
import { cliText } from "../lib/cli-name.ts";
import { render } from "../lib/render.ts";
import {
  getDidFromFile,
  pkcs8FromEntropy,
  pkcs8FromMnemonic,
  pkcs8FromPassphrase,
} from "../lib/identity.ts";

export const identity = new Command()
  .name("id")
  .description("Interact with common identites.")
  .default("help")
  /* id new */
  .command("new", "Output a new identity keyfile to stdout.")
  .example(
    cliText("cf id create > ./my.key"),
    "Create and store a keyfile at ./my.key",
  )
  .action(createIdentity)
  /* id did */
  .command("did <keypath:string>", "Output the DID of a keyfile to stdout.")
  .example(
    cliText("cf id did ./my.key"),
    "Outputs the DID of ./my.key to stdout.",
  )
  .action(getDid)
  /* id derive */
  .command("derive", "Derives a keyfile from the provided passphrase.")
  .example(
    cliText('cf id derive "common user" > ./my.key'),
    'Create and store a keyfile at ./my.key derived from the string "common user".',
  )
  .arguments("<passphrase:string>")
  .action(deriveIdentity)
  /* id from-mnemonic */
  .command(
    "from-mnemonic",
    "Derives a keyfile from a BIP-39 mnemonic phrase, matching browser " +
      "mnemonic login.",
  )
  .example(
    cliText('cf id from-mnemonic "word1 word2 ... word24" > ./my.key'),
    "Create a keyfile whose DID matches a browser identity registered with " +
      "the given recovery phrase. Quote the whole phrase as one argument.",
  )
  .arguments("<mnemonic:string>")
  .action(identityFromMnemonic);

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

async function identityFromMnemonic(_: void, mnemonic: string) {
  const pkcs8Material = await pkcs8FromMnemonic(mnemonic);
  render(pkcs8Material);
}
