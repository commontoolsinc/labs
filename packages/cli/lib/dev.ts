import { type JsScript, Program } from "@commontools/js-runtime";
import { FileSystemProgramResolver } from "@commontools/js-runtime";
import { Identity } from "@commontools/identity";
import { Engine, Runtime } from "@commontools/runner";
import { basename } from "@std/path";

async function createRuntime() {
  const { StorageManager } = await import(
    "@commontools/runner/storage/cache.deno"
  );
  const storageManager = StorageManager.emulate({
    as: await Identity.fromPassphrase("builder"),
  });
  return new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
}

export interface ProcessOptions {
  main: string;
  run: boolean;
  check: boolean;
  output?: string;
  filename?: string;
  showTransformed?: boolean;
  mainExport?: string;
}

export async function process(
  options: ProcessOptions,
): Promise<{ output: JsScript; main?: Record<string, unknown> }> {
  const filename = options.filename
    ? basename(options.filename)
    : options.output
    ? basename(options.output)
    : undefined;
  const engine = new Engine(await createRuntime());
  const program = await engine.resolve(
    new FileSystemProgramResolver(options.main),
  );
  if (options.mainExport) {
    program.mainExport = options.mainExport;
  }
  const getTransformedProgram = options.showTransformed
    ? renderTransformed
    : undefined;
  const { output, main } = await engine.process(program, {
    noCheck: !options.check,
    noRun: !options.run,
    filename,
    getTransformedProgram,
  });

  if (options.output) {
    await Deno.writeTextFile(options.output, output.js);
  }
  return { output, main };
}

function renderTransformed(program: Program) {
  for (const { contents, name } of program.files) {
    console.log(`// transformed: ${name}`);
    console.log(contents);
  }
}
