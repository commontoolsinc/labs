import { Table } from "@cliffy/table";
import { Command, ValidationError } from "@cliffy/command";
import {
  applyCharmInput,
  CharmConfig,
  linkCharms,
  listCharms,
  newCharm,
  saveCharmRecipe,
  setCharmRecipe,
  SpaceConfig,
} from "../lib/charm.ts";
import { render } from "../lib/render.ts";
import { decode } from "@commontools/utils/encoding";
import { absPath } from "../lib/utils.ts";

// Override usage, since we do not "require" args that can be reflected by env vars.
const spaceUsage =
  `--identity <identity> --url <url> --api-url <api-url> --space <space>`;
const charmUsage = `${spaceUsage} --charm <charm>`;

// Render out args for the examples for both `--url`,
// and for the individual components (`--api-url`, `--charm`, `--space`)
const RAW_EX_URL = "https://ct.dev/personal-notes/baed..43mi";
const RAW_EX_COMP = parseUrl(RAW_EX_URL);
const EX_ID = `--identity ./my.key`;
const EX_URL = `--url ${RAW_EX_URL}`;
const EX_COMP = `--api-url ${RAW_EX_COMP.apiUrl} --space ${RAW_EX_COMP.space}`;
const EX_COMP_CHARM = `${EX_COMP} --charm ${RAW_EX_COMP.charm!}`;

export const charm = new Command()
  .name("charm")
  .description(`Interact with charms running on a server.`)
  .default("help")
  .globalOption(
    "-u,--url <url:string>",
    "URL representing a host, space, and charm.",
  )
  .globalEnv("CT_API_URL=<url:string>", "URL of the fabric instance.", {
    prefix: "CT_",
  })
  .globalOption("-a,--api-url <url:string>", "URL of the fabric instance.")
  .globalEnv("CT_IDENTITY=<path:string>", "Path to an identity keyfile.", {
    prefix: "CT_",
  })
  .globalOption("-i,--identity <path:string>", "Path to an identity keyfile.")
  .globalOption("-s,--space <space:string>", "The space name or DID")
  /* charm ls */
  .command("ls", "List charms in space.")
  .usage(spaceUsage)
  .example(
    `ct charm ls ${EX_ID} ${EX_COMP}`,
    `Display a list of all charms in "${RAW_EX_COMP.space}".`,
  )
  .example(
    `ct charm ls ${EX_ID} ${EX_URL}`,
    `Display a list of all charms in "${RAW_EX_COMP.space}".`,
  )
  .action(async (options) => {
    const charmsData = [
      ["ID", "NAME", "RECIPE"],
      ...((await listCharms(parseSpaceOptions(options))).map(
        (
          data,
        ) => [
          data.id,
          data.name ?? "<unnamed>",
          data.recipeName ?? "<unnamed>",
        ],
      )),
    ];
    if (charmsData.length === 1) {
      // Only header fields -- render nothing.
      return;
    }
    render(
      Table.from(charmsData).toString(),
    );
  })
  /* charm new */
  .command("new", "Create a new charm with a recipe.")
  .usage(spaceUsage)
  .example(
    `ct charm new ${EX_ID} ${EX_COMP} ./main.tsx`,
    `Create a new charm, using ./main.tsx as source.`,
  )
  .example(
    `ct charm new ${EX_ID} ${EX_URL} ./main.tsx`,
    `Create a new charm, using ./main.tsx as source.`,
  )
  .arguments("<entry:string>")
  .action(
    async (options, entryPath) =>
      render(
        await newCharm(
          parseSpaceOptions(options),
          absPath(entryPath),
        ),
      ),
  )
  /* charm apply */
  .command("apply", "Pass in new inputs to the target charm")
  .usage(charmUsage)
  .example(
    `echo '{"foo":5}' | ct charm apply ${EX_ID} ${EX_COMP_CHARM}`,
    `Applies the input '{"foo":5}' to charm "${RAW_EX_COMP.charm!}".`,
  )
  .example(
    `echo '{"foo":5}' | ct charm apply ${EX_ID} ${EX_URL}`,
    `Applies the input '{"foo":5}' to charm "${RAW_EX_COMP.charm!}".`,
  )
  .option("-c,--charm <charm:string>", "The target charm ID.")
  .action(async (options) =>
    applyCharmInput(parseCharmOptions(options), await drainStdin())
  )
  /* charm getsrc */
  .command("getsrc", "Retrieve the recipe source for the given charm.")
  .usage(charmUsage)
  .example(
    `ct charm getsrc ${EX_ID} ${EX_COMP_CHARM} ./out`,
    `Retrieve the source for "${RAW_EX_COMP.charm!}" and place in ./out`,
  )
  .example(
    `ct charm getsrc ${EX_ID} ${EX_URL} ./out`,
    `Retrieve the source for "${RAW_EX_COMP.charm!}" and place in ./out`,
  )
  .option("-c,--charm <charm:string>", "The target charm ID.")
  .arguments("<outpath:string>")
  .action((options, outPath) =>
    saveCharmRecipe(parseCharmOptions(options), absPath(outPath))
  )
  /* charm setsrc */
  .command("setsrc", "Update the recipe source for the given charm.")
  .usage(charmUsage)
  .example(
    `ct charm setsrc ${EX_ID} ${EX_COMP_CHARM} ./main.tsx`,
    `Update the source for "${RAW_EX_COMP.charm!}" with ./main.tsx`,
  )
  .example(
    `ct charm setsrc ${EX_ID} ${EX_URL} ./main.tsx`,
    `Update the source for "${RAW_EX_COMP.charm!}" with ./main.tsx`,
  )
  .option("-c,--charm <charm:string>", "The target charm ID.")
  .arguments("<entry:string>")
  .action((options, entryPath) =>
    setCharmRecipe(parseCharmOptions(options), absPath(entryPath))
  )
  /* charm link */
  .command("link", "Link a field from one charm to another")
  .usage(spaceUsage)
  .example(
    `ct charm link ${EX_ID} ${EX_COMP} bafycharm1/outputEmails bafycharm2/emails`,
    `Link outputEmails field from charm "bafycharm1" to emails field in charm "bafycharm2".`,
  )
  .example(
    `ct charm link ${EX_ID} ${EX_COMP} bafycharm1/data/users/0/email bafycharm2/config/primaryEmail`,
    `Link deep nested field including array access.`,
  )
  .arguments("<source:string> <target:string>")
  .action(async (options, sourceRef, targetRef) => {
    const spaceConfig = parseSpaceOptions(options);
    
    // Parse source reference (charmId/path/to/field)
    const sourceParts = sourceRef.split("/");
    if (sourceParts.length < 2) {
      throw new ValidationError(
        `Invalid source reference format. Expected: charmId/path/to/field`,
        { exitCode: 1 },
      );
    }
    const sourceCharmId = sourceParts[0];
    const sourcePath = sourceParts.slice(1).map(segment => {
      // Check if segment is a number (array index)
      const index = parseInt(segment, 10);
      return isNaN(index) ? segment : index;
    });
    
    // Parse target reference (charmId/path/to/field)
    const targetParts = targetRef.split("/");
    if (targetParts.length < 2) {
      throw new ValidationError(
        `Invalid target reference format. Expected: charmId/path/to/field`,
        { exitCode: 1 },
      );
    }
    const targetCharmId = targetParts[0];
    const targetPath = targetParts.slice(1).map(segment => {
      // Check if segment is a number (array index)
      const index = parseInt(segment, 10);
      return isNaN(index) ? segment : index;
    });
    
    await linkCharms(
      spaceConfig,
      sourceCharmId,
      sourcePath,
      targetCharmId,
      targetPath,
    );
    
    render(`Linked ${sourceRef} to ${targetRef}`);
  });

interface CharmCLIOptions {
  charm?: string;
  apiUrl?: string;
  identity?: string;
  space?: string;
  url?: string;
}

export function parseCharmOptions(input: CharmCLIOptions): CharmConfig {
  const options = parseSpaceOptions(input);
  if (!("charm" in options) || !options.charm) {
    throw new ValidationError(
      `Missing required option: "--charm".`,
      { exitCode: 1 },
    );
  }
  return options as CharmConfig;
}

// With args and env vars shadowing each other, and multiple
// ways of defining service components, we cannot make the options
// "required" with cliffy. Ensure that all required values are
// available after parsing both args and env vars.
export function parseSpaceOptions(
  input: CharmCLIOptions,
): SpaceConfig {
  if (input.url && input.space) {
    throw new ValidationError(
      `"--space" cannot be provided when using "--url".`,
      { exitCode: 1 },
    );
  }

  if (!input.identity) {
    throw new ValidationError(
      `Missing required option: "--identity", or "CT_IDENTITY".`,
      { exitCode: 1 },
    );
  }

  const output: Partial<CharmConfig> = {
    identity: absPath(input.identity),
  };

  if (input.url) {
    const { apiUrl, space, charm } = parseUrl(input.url);
    output.apiUrl = apiUrl;
    output.space = space;
    output.charm = charm;
    return output as CharmConfig;
  }

  if (!input.apiUrl) {
    throw new ValidationError(
      `Missing required option: "--api-url", or "CT_API_URL".`,
      { exitCode: 1 },
    );
  }
  if (!input.space) {
    throw new ValidationError(
      `Missing required option: "--space".`,
      { exitCode: 1 },
    );
  }

  if (input.charm) {
    // Do not validate here -- charm is only
    // required via `parseCharmOptions`
    output.charm = input.charm;
  }

  output.apiUrl = input.apiUrl;
  output.space = input.space;

  if (!input.identity) {
    throw new ValidationError(
      `Missing required option: "--identity", or "CT_IDENTITY".`,
      { exitCode: 1 },
    );
  }
  return output as CharmConfig;
}

function parseUrl(
  input: string,
): { apiUrl: string; space: string; charm?: string } {
  let url;
  try {
    url = new URL(input);
  } catch (_) {
    throw new ValidationError(
      `"--url" "${input}" is not a URL.`,
      { exitCode: 1 },
    );
  }
  const apiUrl = `${url.protocol}//${url.host}`;
  const [space, charm] = url.pathname.split("/").filter(Boolean);
  if (!space) {
    throw new ValidationError(
      `"--url" does not contain a space.`,
      { exitCode: 1 },
    );
  }
  return { apiUrl, space, charm };
}

// We use stdin for charm input which must be an `Object`
async function drainStdin(): Promise<object | undefined> {
  let out = "";
  for await (const chunk of Deno.stdin.readable) {
    out += decode(chunk);
  }
  if (!out) {
    return;
  }
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`Could not parse STDIN as JSON: "${out}".`);
  }
}
