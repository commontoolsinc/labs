import { Command } from "@cliffy/command";
import { HelpCommand } from "@cliffy/command/help";
import { dev } from "./dev.ts";
import { init } from "./init.ts";
import { charm } from "./charm.ts";
import { identity } from "./identity.ts";

export const main = new Command()
  .name("ct")
  .description("Tool for running programs on common fabric.")
  .version("0.0.1")
  .default("help")
  .command("help", new HelpCommand().global())
  // This reset is needed to satisfy the typechecker
  // because one of `.command()`'s overloads are not public
  // and cannot match. Still seeing IDE typing errors, but at least
  // deno checker is satisfied.
  .reset()
  // @ts-ignore for the above type issue
  .command("charm", charm)
  .command("dev", dev)
  .command("id", identity)
  .command("init", init);
