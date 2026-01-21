import { Command } from "@cliffy/command";
import { HelpCommand } from "@cliffy/command/help";
import { acl } from "./acl.ts";
import { check, dev } from "./dev.ts";
import { init } from "./init.ts";
import { charm } from "./charm.ts";
import { identity } from "./identity.ts";
import { test } from "./test.ts";

const mainDescription = `Tool for running programs on common fabric.

QUICK START:
  ct check ./pattern.tsx             # Type-check and test locally
  ct charm new ./pattern.tsx ...    # Deploy to a space
  ct charm --help                   # Help for deployed patterns (with tips)

FIRST TIME SETUP:
  ct id new > claude.key            # Create identity key
  export CT_IDENTITY=./claude.key   # Set default identity
  export CT_API_URL=http://localhost:8000  # Set default API URL

LOCAL DEVELOPMENT:
  ./scripts/start-local-dev.sh      # Start local servers
  ./scripts/stop-local-dev.sh       # Stop local servers

Run 'ct <command> --help' for command-specific help.`;

export const main = new Command()
  .name("ct")
  .description(mainDescription)
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
  .command("acl", acl)
  // @ts-ignore for the above type issue
  .command("charm", charm)
  .command("check", check)
  .command("dev", dev)
  .command("id", identity)
  .command("init", init)
  .command("test", test);
