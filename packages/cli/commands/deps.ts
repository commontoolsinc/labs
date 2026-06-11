import { Command } from "@cliffy/command";
import { loadManager } from "../lib/piece.ts";
import { parseSpaceOptions } from "./piece.ts";
import {
  pinProgramFabricImports,
  renderPinRewrite,
} from "../lib/fabric-deps.ts";
import { absPath } from "../lib/utils.ts";
import { render } from "../lib/render.ts";
import { cliText } from "../lib/cli-name.ts";

export const deps = new Command()
  .name("deps")
  .description("Manage fabric import dependencies.")
  .default("help")
  .globalOption(
    "-u,--url <url:string>",
    "URL representing a host, space, and piece.",
  )
  .globalEnv("CF_API_URL=<url:string>", "URL of the fabric instance.", {
    prefix: "CF_",
  })
  .globalOption("-a,--api-url <url:string>", "URL of the fabric instance.")
  .globalEnv("CF_IDENTITY=<path:string>", "Path to an identity keyfile.", {
    prefix: "CF_",
  })
  .globalOption("-i,--identity <path:string>", "Path to an identity keyfile.")
  .globalOption("-s,--space <space:string>", "The space name or DID")
  .command("update", "Pin mutable fabric imports in a local source file.")
  .arguments("<file:string>")
  .option(
    "--import <specifier:string>",
    "Only update one matching import specifier.",
  )
  .option(
    "--check",
    "Exit non-zero if any pin would change without writing the file.",
  )
  .action(async (options, file) => {
    const config = parseSpaceOptions(options);
    const manager = await loadManager(config);
    const filePath = absPath(file);
    const contents = await Deno.readTextFile(filePath);
    const result = await pinProgramFabricImports(
      manager.runtime,
      manager.getSpace(),
      {
        main: filePath,
        files: [{ name: filePath, contents }],
      },
      { importSpecifier: options.import },
    );

    for (const rewrite of result.rewrites) {
      render(`${file}:${rewrite.line} ${renderPinRewrite(rewrite)}`);
    }

    if (options.check && result.rewrites.length > 0) {
      throw new Error(
        cliText("fabric dependencies are not pinned; run cf deps update"),
      );
    }

    if (!options.check && result.rewrites.length > 0) {
      await Deno.writeTextFile(filePath, result.program.files[0].contents);
    }
  });
