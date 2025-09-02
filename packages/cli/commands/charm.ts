import { Table } from "@cliffy/table";
import { Command, ValidationError } from "@cliffy/command";
import {
  applyCharmInput,
  callCharmHandler,
  CharmConfig,
  formatViewTree,
  generateSpaceMap,
  getCellValue,
  getCharmView,
  inspectCharm,
  linkCharms,
  listCharms,
  loadManager,
  MapFormat,
  newCharm,
  removeCharm,
  saveCharmRecipe,
  setCellValue,
  setCharmRecipe,
  SpaceConfig,
} from "../lib/charm.ts";
import { CharmsController } from "@commontools/charm/ops";
import { renderCharm } from "../lib/charm-render.ts";
import { render, safeStringify } from "../lib/render.ts";
import { decode } from "@commontools/utils/encoding";
import { absPath } from "../lib/utils.ts";
import { parsePath } from "@commontools/charm/ops";

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
  .arguments("<main:string>")
  .option("--start", "Start the charm after creation for one step")
  .option(
    "--main-export <export:string>",
    'Named export from entry for recipe definition. Defaults to "default".',
  )
  .action(
    async (options, main) =>
      render(
        await newCharm(
          parseSpaceOptions(options),
          { mainPath: absPath(main), mainExport: options.mainExport },
          { start: options.start },
        ),
      ),
  )
  /* charm step */
  .command("step", "Run a single scheduling step: start → idle → synced → stop")
  .usage(charmUsage)
  .example(
    `ct charm step ${EX_ID} ${EX_COMP_CHARM}`,
    `Start, wait for idle+synced, then stop charm "${RAW_EX_COMP.charm!}".`,
  )
  .option("-c,--charm <charm:string>", "The target charm ID.")
  .action(async (options) => {
    const charmConfig = parseCharmOptions(options);
    const manager = await loadManager(charmConfig);
    const charms = new CharmsController(manager);
    // Start in this transient runtime, wait, then stop and exit
    await charms.start(charmConfig.charm);
    await manager.runtime.idle();
    await manager.synced();
    await charms.stop(charmConfig.charm);
    render(`Stepped charm ${charmConfig.charm}`);
  })
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
  .option(
    "--main-export <export:string>",
    'Named export from entry for recipe definition. Defaults to "default".',
  )
  .arguments("<main:string>")
  .action((options, mainPath) =>
    setCharmRecipe(parseCharmOptions(options), {
      mainPath: absPath(mainPath),
      mainExport: options.mainExport,
    })
  )
  /* charm inspect */
  .command("inspect", "Inspect detailed information about a charm")
  .usage(charmUsage)
  .example(
    `ct charm inspect ${EX_ID} ${EX_COMP_CHARM}`,
    `Inspect detailed information about charm "${RAW_EX_COMP.charm!}".`,
  )
  .example(
    `ct charm inspect ${EX_ID} ${EX_URL}`,
    `Inspect detailed information about charm "${RAW_EX_COMP.charm!}".`,
  )
  .option("-c,--charm <charm:string>", "The target charm ID.")
  .option("--json", "Output raw JSON data")
  .action(async (options) => {
    const charmConfig = parseCharmOptions(options);

    const charmData = await inspectCharm(charmConfig);

    if (options.json) {
      // In JSON mode, use render with JSON output
      render(charmData, { json: true });
      return;
    }

    // Build formatted output as template
    let output = `
=== Charm: ${charmData.id} ===
Name: ${charmData.name || "<no name>"}
Recipe: ${charmData.recipeName || "<no recipe name>"}

--- Source (Inputs) ---`;

    if (charmData.source) {
      output += `\n${safeStringify(charmData.source)}`;
    } else {
      output += "\n<no source data>";
    }

    output += "\n\n--- Result ---";
    if (charmData.result) {
      // Filter out large UI objects that clutter the output
      const filteredResult = { ...charmData.result };
      if (filteredResult.$UI && typeof filteredResult.$UI === "object") {
        filteredResult.$UI = "<large UI object - use --json to see full UI>";
      }
      output += `\n${safeStringify(filteredResult)}`;
    } else {
      output += "\n<no result data>";
    }

    output += "\n\n--- Reading From ---";
    if (charmData.readingFrom.length > 0) {
      charmData.readingFrom.forEach((ref) => {
        output += `\n  - ${ref.id}${ref.name ? ` (${ref.name})` : ""}`;
      });
    } else {
      output += "\n  (none)";
    }

    output += "\n\n--- Read By ---";
    if (charmData.readBy.length > 0) {
      charmData.readBy.forEach((ref) => {
        output += `\n  - ${ref.id}${ref.name ? ` (${ref.name})` : ""}`;
      });
    } else {
      output += "\n  (none)";
    }

    render(output);
  })
  /* charm view */
  .command("view", "Display the rendered view for a charm")
  .usage(charmUsage)
  .example(
    `ct charm view ${EX_ID} ${EX_COMP_CHARM}`,
    `Display the view for charm "${RAW_EX_COMP.charm!}".`,
  )
  .example(
    `ct charm view ${EX_ID} ${EX_URL}`,
    `Display the view for charm "${RAW_EX_COMP.charm!}".`,
  )
  .option("-c,--charm <charm:string>", "The target charm ID.")
  .option("--json", "Output raw JSON data")
  .action(async (options) => {
    const charmConfig = parseCharmOptions(options);
    const view = await getCharmView(charmConfig);
    if (options.json) {
      render(view ?? null, { json: true });
      return;
    }
    if (view) {
      const tree = formatViewTree(view);
      render(tree);
    } else {
      render("<no view data>");
    }
  })
  /* charm render */
  .command("render", "Render a charm's UI to HTML")
  .usage(charmUsage)
  .example(
    `ct charm render ${EX_ID} ${EX_COMP_CHARM}`,
    `Render the UI for charm "${RAW_EX_COMP.charm!}" to HTML.`,
  )
  .example(
    `ct charm render ${EX_ID} ${EX_URL}`,
    `Render the UI for charm "${RAW_EX_COMP.charm!}" to HTML.`,
  )
  .example(
    `ct charm render ${EX_ID} ${EX_COMP_CHARM} --watch`,
    `Watch and re-render charm "${RAW_EX_COMP.charm!}" when UI changes.`,
  )
  .option("-c,--charm <charm:string>", "The target charm ID.")
  .option("--json", "Output HTML as JSON")
  .option("-w,--watch", "Watch for changes and re-render")
  .action(async (options) => {
    const charmConfig = parseCharmOptions(options);

    try {
      if (options.watch) {
        console.log("Watching for changes... Press Ctrl+C to exit.\n");

        // Initial render
        const charmData = await inspectCharm(charmConfig);
        console.log(`Rendering charm: ${charmData.name || charmConfig.charm}`);

        let renderCount = 0;
        const cleanup = await renderCharm(charmConfig, {
          watch: true,
          onUpdate: (html) => {
            renderCount++;
            console.log(`\n--- Render #${renderCount} ---`);
            if (options.json) {
              render({ html, renderCount }, { json: true });
            } else {
              render(html);
            }
          },
        }) as () => void;

        // Handle Ctrl+C gracefully
        Deno.addSignalListener("SIGINT", () => {
          console.log("\nStopping watch mode...");
          cleanup();
          Deno.exit(0);
        });

        // Keep the process running
        await new Promise(() => {});
      } else {
        const html = await renderCharm(charmConfig) as string;
        if (options.json) {
          render({ html }, { json: true });
        } else {
          render(html);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("has no UI")) {
        render("<charm has no UI>");
      } else {
        throw error;
      }
    }
  })
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
  .example(
    `ct charm link ${EX_ID} ${EX_COMP} baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye bafycharm1/allCharms`,
    `Link well-known charms list to charm field.`,
  )
  .arguments("<source:string> <target:string>")
  .action(async (options, sourceRef, targetRef) => {
    const spaceConfig = parseSpaceOptions(options);

    // Parse source and target references - handle both charmId/path and well-known IDs
    const source = parseLink(sourceRef, { allowWellKnown: true });
    const target = parseLink(targetRef);

    // For linking, sources can be either:
    // 1. charmId (links entire result cell)
    // 2. charmId/path/to/field (links specific field in result cell)
    // Both well-known IDs and regular charm IDs can link without a path

    if (!target.path) {
      throw new ValidationError(
        `Target reference must include a path. Expected: charmId/path/to/field`,
        { exitCode: 1 },
      );
    }

    await linkCharms(
      spaceConfig,
      source.charmId,
      source.path || [], // Empty path for well-known IDs
      target.charmId,
      target.path,
    );

    render(`Linked ${sourceRef} to ${targetRef}`);
  })
  /* charm get */
  .command("get", "Get a value from a charm at a specific path")
  .usage(charmUsage)
  .example(
    `ct charm get ${EX_ID} ${EX_COMP_CHARM} name`,
    `Get the "name" field from charm result "${RAW_EX_COMP.charm!}".`,
  )
  .example(
    `ct charm get ${EX_ID} ${EX_COMP_CHARM} data/users/0/email --input`,
    `Get a nested field value from charm input "${RAW_EX_COMP.charm!}".`,
  )
  .option("-c,--charm <charm:string>", "The target charm ID.")
  .option("--input", "Read from the charm's input cell instead of result cell")
  .arguments("<path:string>")
  .action(async (options, pathString) => {
    const charmConfig = parseCharmOptions(options);
    const pathSegments = parsePath(pathString);
    const value = await getCellValue(charmConfig, pathSegments, {
      input: options.input,
    });
    render(value, { json: true });
  })
  /* charm set */
  .command("set", "Set a value in a charm at a specific path")
  .usage(charmUsage)
  .example(
    `echo '"New Name"' | ct charm set ${EX_ID} ${EX_COMP_CHARM} name`,
    `Set the "name" field in charm result "${RAW_EX_COMP.charm!}".`,
  )
  .example(
    `echo '{"foo": "bar"}' | ct charm set ${EX_ID} ${EX_COMP_CHARM} config --input`,
    `Set a nested object value in charm input "${RAW_EX_COMP.charm!}".`,
  )
  .option("-c,--charm <charm:string>", "The target charm ID.")
  .option("--input", "Write to the charm's input cell instead of result cell")
  .arguments("<path:string>")
  .action(async (options, pathString) => {
    const charmConfig = parseCharmOptions(options);
    const pathSegments = parsePath(pathString);
    const value = await drainStdin();
    await setCellValue(charmConfig, pathSegments, value, {
      input: options.input,
    });
    render(`Set value at path: ${pathString}`);
  })
  /* charm map */
  .command("map", "Display a visual map of all charms and their connections")
  .usage(spaceUsage)
  .example(
    `ct charm map ${EX_ID} ${EX_COMP}`,
    `Display a map of all charms and connections in "${RAW_EX_COMP.space}".`,
  )
  .example(
    `ct charm map ${EX_ID} ${EX_COMP} --format dot`,
    `Output Graphviz DOT format for the space.`,
  )
  .option(
    "-f,--format <format:string>",
    "Output format: ascii (default) or dot (Graphviz)",
    { default: "ascii" },
  )
  .action(async (options) => {
    const spaceConfig = parseSpaceOptions(options);
    const format = options.format === "dot" ? MapFormat.DOT : MapFormat.ASCII;

    const map = await generateSpaceMap(spaceConfig, format);
    render(map);
  })
  /* charm call */
  .command("call", "Call a handler within a charm")
  .usage(charmUsage)
  .example(
    `ct charm call ${EX_ID} ${EX_COMP_CHARM} increment`,
    `Call the "increment" handler on charm "${RAW_EX_COMP.charm!}".`,
  )
  .example(
    `ct charm call ${EX_ID} ${EX_COMP_CHARM} setName '{"value":"My Name"}'`,
    `Call the "setName" handler with arguments on charm "${RAW_EX_COMP
      .charm!}".`,
  )
  .option("-c,--charm <charm:string>", "The target charm ID.")
  .arguments("<handler:string> [args:string]")
  .action(async (options, handlerName, argsJson) => {
    const charmConfig = parseCharmOptions(options);
    const args = argsJson ? JSON.parse(argsJson) : await drainStdin();
    await callCharmHandler(charmConfig, handlerName, args);
    render(`Called handler "${handlerName}" on charm ${charmConfig.charm}`);
  })
  /* charm rm */
  .command("rm", "Remove a charm")
  .alias("remove")
  .usage(charmUsage)
  .example(
    `ct charm rm ${EX_ID} ${EX_COMP_CHARM}`,
    `Remove charm "${RAW_EX_COMP.charm!}".`,
  )
  .example(
    `ct charm rm ${EX_ID} ${EX_URL}`,
    `Remove charm "${RAW_EX_COMP.charm!}".`,
  )
  .option("-c,--charm <charm:string>", "The target charm ID.")
  .action(async (options) => {
    const charmConfig = parseCharmOptions(options);
    await removeCharm(charmConfig);
    render(`Removed charm ${charmConfig.charm}`);
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

export function parseLink(
  ref: string,
  options?: { allowWellKnown?: boolean },
): { charmId: string; path?: (string | number)[] } {
  const parts = ref.split("/");
  if (parts.length < 1) {
    throw new ValidationError(
      `Invalid reference format. Expected: charmId or charmId/path/to/field`,
      { exitCode: 1 },
    );
  }

  const charmId = parts[0];

  if (parts.length === 1) {
    // If this is a well-known ID (no path) and allowWellKnown is not explicitly true,
    // we might want to handle it differently in the future
    return { charmId };
  }

  const path = parsePath(parts.slice(1).join("/"));
  return { charmId, path };
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
async function drainStdin(): Promise<object> {
  let out = "";
  for await (const chunk of Deno.stdin.readable) {
    out += decode(chunk);
  }
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`Could not parse STDIN as JSON: "${out}".`);
  }
}
