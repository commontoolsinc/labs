import { Command } from "@cliffy/command";
import { Table } from "@cliffy/table";
import {
  getAcl,
  removeAclEntry,
  setAclEntry,
  SpaceConfig,
} from "../lib/acl.ts";
import { render } from "../lib/render.ts";
import { isCapability } from "@commontools/memory";

// Usage patterns for examples
const spaceUsage = `--identity <identity> --api-url <api-url> --space <space>`;

export const acl = new Command()
  .name("acl")
  .description("Manage Access Control Lists for spaces.")
  .default("help")
  .globalEnv("CT_API_URL=<url:string>", "URL of the fabric instance.", {
    prefix: "CT_",
  })
  .globalOption("-a,--api-url <url:string>", "URL of the fabric instance.")
  .globalEnv("CT_IDENTITY=<path:string>", "Path to an identity keyfile.", {
    prefix: "CT_",
  })
  .globalOption("-i,--identity <path:string>", "Path to an identity keyfile.")
  .globalOption("-s,--space <space:string>", "The space name or DID")
  /* acl ls */
  .command("ls", "List all ACL entries for a space.")
  .usage(spaceUsage)
  .example(
    "ct acl ls --identity ./my.key --api-url https://api.example.com --space my-space",
    "List all ACL entries for my-space",
  )
  .action(async (options) => {
    const config = parseSpaceOptions(options);
    const aclData = await getAcl(config);

    if (!aclData || Object.keys(aclData).length === 0) {
      render("No ACL entries found.");
      return;
    }

    new Table()
      .header(["DID", "CAPABILITY"])
      .body(
        Object.entries(aclData).map(([did, capability]) => [did, capability]),
      )
      .border(true)
      .render();
  })
  /* acl set */
  .command(
    "set <did:string> <capability:string>",
    "Applies a capability (READ, WRITE, OWNER) to an identity (DID) to the space ACL.",
  )
  .usage(`${spaceUsage} <did> <capability>`)
  .example(
    "ct acl set did:key:z6Mkk... WRITE --identity ./my.key --api-url https://api.example.com --space my-space",
    "Grant WRITE capability to a DID",
  )
  .action(async (options, did, capability) => {
    const cap = capability.toUpperCase();
    if (!isCapability(cap)) {
      render(
        `Invalid capability: ${capability}. Must be one of: READ, WRITE, OWNER`,
      );
      Deno.exit(1);
    }

    const config = parseSpaceOptions(options);
    await setAclEntry(
      config,
      did,
      cap as "READ" | "WRITE" | "OWNER",
    );
    render(`Added ${did} with ${cap} capability`);
  })
  /* acl remove */
  .command("remove <did:string>", "Remove a DID from the space ACL.")
  .usage(`${spaceUsage} <did>`)
  .example(
    "ct acl remove did:key:z6Mkk... --identity ./my.key --api-url https://api.example.com --space my-space",
    "Remove a DID from the ACL",
  )
  .action(async (options, did) => {
    const config = parseSpaceOptions(options);
    await removeAclEntry(config, did);
    render(`Removed ${did} from ACL`);
  });

/**
 * Parse space-related options from command arguments
 */
function parseSpaceOptions(
  options: Record<string, string | undefined>,
): SpaceConfig {
  const apiUrl = options.apiUrl || Deno.env.get("CT_API_URL");
  const identity = options.identity || Deno.env.get("CT_IDENTITY");
  const space = options.space;

  if (!apiUrl) {
    render(
      "Error: --api-url is required or set CT_API_URL environment variable",
    );
    Deno.exit(1);
  }

  if (!identity) {
    render(
      "Error: --identity is required or set CT_IDENTITY environment variable",
    );
    Deno.exit(1);
  }

  if (!space) {
    render("Error: --space is required");
    Deno.exit(1);
  }

  return {
    apiUrl: new URL(apiUrl),
    identityPath: identity,
    spaceName: space,
  };
}
