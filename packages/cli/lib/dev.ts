import { Program } from "@commonfabric/js-compiler";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { Identity } from "@commonfabric/identity";
import { Engine, Runtime } from "@commonfabric/runner";
import { experimentalOptionsFromEnv } from "./utils.ts";

async function createRuntime() {
  const { StorageManager } = await import(
    "@commonfabric/runner/storage/cache.deno"
  );
  const storageManager = StorageManager.emulate({
    as: await Identity.fromPassphrase("builder"),
  });
  return new Runtime({
    storageManager,
    experimental: experimentalOptionsFromEnv(),
    apiUrl: new URL(import.meta.url),
  });
}

export interface ProcessOptions {
  main: string;
  rootPath?: string;
  run: boolean;
  check: boolean;
  output?: string;
  showTransformed?: boolean;
  mainExport?: string;
  verboseErrors?: boolean;
}

export async function process(
  options: ProcessOptions,
): Promise<{ output: string; main?: Record<string, unknown> }> {
  const runtime = await createRuntime();
  const engine = new Engine(runtime);
  const program = await engine.resolve(
    new FileSystemProgramResolver(options.main, options.rootPath),
  );
  if (options.mainExport) {
    program.mainExport = options.mainExport;
  }
  const getTransformedProgram = options.showTransformed
    ? renderTransformed
    : undefined;
  const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
    program,
    {
      noCheck: !options.check,
      getTransformedProgram,
      verboseErrors: options.verboseErrors,
    },
  );

  // Concatenated per-module compiled bodies (the same composition the SES
  // loader evaluates), for inspection via --output.
  const output = [...graph.compiledBodies.entries()]
    .map(([specifier, body]) => `// ${specifier}\n${body}`)
    .join("\n");
  if (options.output) {
    await Deno.writeTextFile(options.output, output);
  }

  if (!options.run) {
    return { output };
  }

  const { main } = engine.evaluateRecordGraph(
    id,
    graph,
    mainSpecifier,
    program.files,
  );
  return { output, main };
}

function renderTransformed(program: Program) {
  for (const { contents, name } of program.files) {
    console.log(`// transformed: ${name}`);
    console.log(contents);
  }
}
