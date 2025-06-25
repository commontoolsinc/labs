import { Command } from "@cliffy/command";
import { handleCommand } from "../lib/handler.ts";
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
  .action(async () => await handleCommand(pkcs8FromEntropy()))
  /* id did */
  .command("did <keypath:string>", "Output the DID of a keyfile to stdout.")
  .example("ct id did ./my.key", "Outputs the DID of ./my.key to stdout.")
  .action(async (_, keypath: string) =>
    await handleCommand(getDidFromFile(keypath))
  )
  /* id derive */
  .command("derive", "Derives a keyfile from the provided passphrase.")
  .example(
    'ct id derive "common user" > ./my.key',
    'Create and store a keyfile at ./my.key derived from the string "common user".',
  )
  .arguments("<passphrase:string>")
  .action(async (_, passphrase: string) =>
    await handleCommand(pkcs8FromPassphrase(passphrase))
  );
