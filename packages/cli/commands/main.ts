import { Command } from "@cliffy/command";
import { HelpCommand } from "@cliffy/command/help";
import { acl } from "./acl.ts";
import { check, dev } from "./dev.ts";
import { exec } from "./exec.ts";
import { fuse } from "./fuse.ts";
import { init } from "./init.ts";
import { piece } from "./piece.ts";
import { identity } from "./identity.ts";
import { test } from "./test.ts";
import ports from "@commontools/ports" with { type: "json" };
import { cliName, cliText } from "../lib/cli-name.ts";

function envStatus(): string {
  const identity = Deno.env.get("CF_IDENTITY");
  const apiUrl = Deno.env.get("CF_API_URL");
  if (!identity && !apiUrl) return "";
  const lines: string[] = ["", "ENVIRONMENT:"];
  if (identity) {
    lines.push(`  CF_IDENTITY = ${identity} (set, no need to pass --identity)`);
  }
  if (apiUrl) {
    lines.push(`  CF_API_URL  = ${apiUrl} (set, no need to pass --api-url)`);
  }
  return lines.join("\n");
}

const mainDescription = cliText(`Tool for running programs on common fabric.

QUICK START:
  cf check ./pattern.tsx            # Type-check and test locally
  cf piece new ./pattern.tsx ...    # Deploy to a space
  cf piece --help                   # Help for deployed patterns (with tips)

FIRST TIME SETUP:
  cf id new > claude.key            # Create identity key
  export CF_IDENTITY=./claude.key   # Set default identity
  export CF_API_URL=http://localhost:${ports.toolshed}  # Set default API URL

LOCAL DEVELOPMENT:
  ./scripts/start-local-dev.sh      # Start local servers
  ./scripts/stop-local-dev.sh       # Stop local servers
${envStatus()}
LOGGING:
  Only errors are shown by default. Enable more with:
    cf --log-level info check ./pattern.tsx
    CF_LOG_LEVEL=debug cf piece ls
  Valid levels: debug, info, warn, error (default), silent

Run 'cf <command> --help' for command-specific help.`);

export const main = new Command()
  .name(cliName())
  .description(mainDescription)
  .version("0.0.1")
  // Add global help subcommand to all commands
  // like `cf foo help` -- this is OK, but the most appealing
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
  .command("piece", piece)
  .command("check", check)
  .command("dev", dev)
  .command("exec", exec)
  // @ts-ignore for the above type issue
  .command("fuse", fuse)
  .command(
    "fuse-daemon",
    new Command()
      .description(
        "Internal: run the FUSE daemon directly (used by compiled binary).",
      )
      .hidden()
      .useRawArgs()
      .action(async (_options: unknown, ...rawArgs: unknown[]) => {
        const { main } = await import("@commonfabric/fuse");
        const daemonArgs = rawArgs.map((arg) => String(arg));
        await main(daemonArgs);
      }),
  )
  .command("id", identity)
  .command("init", init)
  .command("test", test)
  .command(
    "deploy",
    new Command()
      .description(cliText("Use 'cf piece new' instead."))
      .hidden()
      .action(() => {
        console.log(
          cliText(
            "The 'deploy' command does not exist. Use 'cf piece new' to deploy a pattern.",
          ),
        );
      }),
  );
