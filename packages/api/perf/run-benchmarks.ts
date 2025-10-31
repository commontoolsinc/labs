#!/usr/bin/env -S deno run -A

const CONFIGS = [
  "tsconfig.baseline.json",
  "tsconfig.key.json",
  "tsconfig.anycell.json",
  "tsconfig.schema.json",
  "tsconfig.ikeyable-cell.json",
  "tsconfig.ikeyable-schema.json",
  "tsconfig.ikeyable-realistic.json",
] as const;

const scriptDir = new URL(".", import.meta.url);
const cwd = scriptDir.pathname;

function fromFileUrl(url: URL): string {
  if (url.protocol !== "file:") throw new TypeError("URL must be a file URL");
  const path = decodeURIComponent(url.pathname);
  if (Deno.build.os === "windows") {
    return path.slice(1).replaceAll("/", "\\");
  }
  return path;
}

const tscPath = fromFileUrl(
  new URL(
    "../../../node_modules/.deno/typescript@5.8.3/node_modules/typescript/bin/tsc",
    import.meta.url,
  ),
);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function runScenario(config: string) {
  console.log(`# ${config}`);

  const command = new Deno.Command(tscPath, {
    args: ["--project", config, "--extendedDiagnostics", "--pretty", "false"],
    cwd,
  });

  const { code, stdout, stderr } = await command.output();
  if (code !== 0) {
    const err = decoder.decode(stderr);
    console.error(err);
    throw new Error(`Benchmark failed for ${config}`);
  }

  const output = decoder.decode(stdout);
  console.log(output);

  const summary: string[] = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("Instantiations:")) {
      summary.push(line.trim());
    } else if (line.startsWith("Check time:")) {
      summary.push(line.trim());
    }
  }

  if (summary.length > 0) {
    await Deno.stdout.write(
      encoder.encode(
        `${summary.join(" | ")}\n----------------------------------------\n\n`,
      ),
    );
  } else {
    console.log("----------------------------------------\n");
  }
}

for (const config of CONFIGS) {
  await runScenario(config);
}
