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
  // Add global help subcommand to all commands
  // like `ct foo help` -- this is OK, but the most appealing
  // feature here is adding a "default" command when none are provided
  // as a way to display help text on a root command.
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
