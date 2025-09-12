import { type JsScript } from "@commontools/js-runtime";
import { FileSystemProgramResolver } from "@commontools/js-runtime/deno";
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
  return new Runtime({ storageManager, blobbyServerUrl: import.meta.url });
}

export interface ProcessOptions {
  main: string;
  run: boolean;
  check: boolean;
  output?: string;
  filename?: string;
  showTransformed?: boolean;
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
  const { output, main } = await engine.process(program, {
    noCheck: !options.check,
    noRun: !options.run,
    filename,
    showTransformed: options.showTransformed,
  });

  if (options.output) {
    await Deno.writeTextFile(options.output, output.js);
  }
  return { output, main };
}
