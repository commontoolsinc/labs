import { Command } from "@cliffy/command";
import { HelpCommand } from "@cliffy/command/help";
import { acl } from "./acl.ts";
import { check, dev } from "./dev.ts";
import { deps } from "./deps.ts";
import { exec } from "./exec.ts";
import { fuse } from "./fuse.ts";
import { init } from "./init.ts";
import { inspect } from "./inspect.ts";
import { piece } from "./piece.ts";
import { identity } from "./identity.ts";
import { test } from "./test-command.ts";
import { view } from "./view.ts";
import { wish } from "./wish.ts";
import ports from "@commonfabric/ports" with { type: "json" };
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
  Warnings and errors are shown by default. Adjust with:
    cf --log-level info check ./pattern.tsx
    cf --log-level error check ./pattern.tsx   # quieter: errors only
    CF_LOG_LEVEL=debug cf piece ls
  Valid levels: debug, info, warn (default), error, silent

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
  .command("deps", deps)
  // @ts-ignore for the above type issue
  .command("inspect", inspect)
  .command("view", view)
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
  .command(
    "fuse-supervisor",
    new Command()
      .description(
        "Internal: supervise a background FUSE child process.",
      )
      .hidden()
      .arguments("<mountpoint:string>")
      .option("--api-url <url:string>", "URL of the fabric instance.")
      .option("--identity <path:string>", "Path to an identity keyfile.")
      .option("--exec-cli <path:string>", "Path to the cf exec shim.")
      .option("--log-file <path:string>", "Path to the FUSE child log file.")
      .option("--allow-other", "Pass allow_other through to the FUSE child.")
      .option("--noattrcache", "Pass noattrcache through to the FUSE child.")
      .option(
        "--attrcache-timeout <seconds:string>",
        "Pass attrcache-timeout through to the FUSE child.",
      )
      .option("--cfc-mode <mode:string>", "FUSE-side CFC mode.")
      .option("--cfc-annotations", "Publish CFC annotation xattrs.")
      .option(
        "--cfc-xattr-namespace <namespace:string>",
        "CFC xattr namespace.",
      )
      .option("--cfc-writeback-xattrs", "Enable CFC writeback xattrs.")
      .option(
        "--cfc-writeback-state <path:string>",
        "CFC writeback state path.",
      )
      .option(
        "--dangerously-allow-incompatible-schema",
        "Allow incompatible source schema updates.",
      )
      .option("--state-path <path:string>", "Mount state file to update.")
      .option(
        "--supervisor-status <path:string>",
        "Child readiness and heartbeat status file.",
      )
      .option("-s, --space <name:string>", "Space(s) to connect.", {
        collect: true,
      })
      .action(async (options, mountpoint) => {
        const { runFuseSupervisor } = await import("../lib/fuse-supervisor.ts");
        await runFuseSupervisor({
          mountpoint,
          apiUrl: options.apiUrl ?? "",
          identity: options.identity ?? "",
          execCli: options.execCli ?? "",
          logFile: options.logFile ?? "",
          spaces: options.space ?? [],
          allowOther: options.allowOther,
          noattrcache: options.noattrcache,
          attrcacheTimeout: options.attrcacheTimeout,
          cfcMode: options.cfcMode,
          cfcAnnotations: options.cfcAnnotations,
          cfcXattrNamespace: options.cfcXattrNamespace,
          cfcWritebackXattrs: options.cfcWritebackXattrs,
          cfcWritebackState: options.cfcWritebackState,
          dangerouslyAllowIncompatibleSchema:
            options.dangerouslyAllowIncompatibleSchema,
          statePath: options.statePath,
          supervisorStatusPath: options.supervisorStatus,
        });
      }),
  )
  .command("id", identity)
  .command("init", init)
  .command("test", test)
  .command("wish", wish)
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
