import { Command } from "@cliffy/command";
import {
  getSpaceExecutionPolicy,
  setSpaceExecutionPolicy,
} from "../lib/execution.ts";
import { parseSpaceOptions } from "./acl.ts";
import { cliText } from "../lib/cli-name.ts";
import { render } from "../lib/render.ts";

const usage = "--identity <identity> --api-url <api-url> --space <space>";

export const execution = new Command()
  .name("execution")
  .description("Manage server-primary execution policy for a space owner.")
  .default("help")
  .globalEnv("CF_API_URL=<url:string>", "URL of the fabric instance.", {
    prefix: "CF_",
  })
  .globalOption("-a,--api-url <url:string>", "URL of the fabric instance.")
  .globalEnv("CF_IDENTITY=<path:string>", "Path to an identity keyfile.", {
    prefix: "CF_",
  })
  .globalOption("-i,--identity <path:string>", "Path to an identity keyfile.")
  .globalOption("-s,--space <space:string>", "The space name or DID")
  .command("enable", "Enable server-primary claims for this space.")
  .usage(usage)
  .example(
    cliText("cf execution enable --space my-space"),
    "Enable after server and clients advertise the execution capabilities.",
  )
  .action(async (options) => {
    const config = parseSpaceOptions(options);
    await setSpaceExecutionPolicy(config, true);
    render(`Server-primary execution enabled for ${config.space}.`);
  })
  .command("disable", "Return this space to client-primary authority.")
  .usage(usage)
  .action(async (options) => {
    const config = parseSpaceOptions(options);
    await setSpaceExecutionPolicy(config, false);
    render(`Server-primary execution disabled for ${config.space}.`);
  })
  .command("status", "Read the current space execution policy.")
  .usage(usage)
  .action(async (options) => {
    const config = parseSpaceOptions(options);
    const status = await getSpaceExecutionPolicy(config);
    render(`Server-primary execution policy for ${config.space}: ${status}`);
  });
