import { type JsScript, Program } from "@commonfabric/js-compiler";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { Identity } from "@commonfabric/identity";
import { Engine, Runtime } from "@commonfabric/runner";
import { basename } from "@std/path";
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
  filename?: string;
  showTransformed?: boolean;
  mainExport?: string;
  verboseErrors?: boolean;
}

export async function process(
  options: ProcessOptions,
): Promise<{ output: JsScript; main?: Record<string, unknown> }> {
  const filename = options.filename
    ? basename(options.filename)
    : options.output
    ? basename(options.output)
    : undefined;
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
  const { jsScript, id } = await engine.compile(program, {
    noCheck: !options.check,
    filename,
    getTransformedProgram,
    verboseErrors: options.verboseErrors,
  });

  if (options.output) {
    await Deno.writeTextFile(options.output, jsScript.js);
  }

  if (!options.run) {
    return { output: jsScript };
  }

  const { main } = await engine.evaluate(id, jsScript, program.files);
  return { output: jsScript, main };
}

function renderTransformed(program: Program) {
  for (const { contents, name } of program.files) {
    console.log(`// transformed: ${name}`);
    console.log(contents);
  }
}
