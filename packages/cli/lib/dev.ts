import {
  type JsScript,
  type ProgramResolver,
  type Source,
} from "@commontools/js-runtime";
import { Identity } from "@commontools/identity";
import { Engine, Runtime } from "@commontools/runner";
import { basename, dirname, join } from "@std/path";

async function createRuntime() {
  const { StorageManager } = await import(
    "@commontools/runner/storage/cache.deno"
  );
  const storageManager = StorageManager.emulate({
    as: await Identity.fromPassphrase("builder"),
  });
  return new Runtime({ storageManager, blobbyServerUrl: import.meta.url });
}

// Extend `EngineProgramResolver` to add the necessary 3P module
// types when needed, but otherwise lazily crawl the filesystem
// while walking source files
export class CliProgram implements ProgramResolver {
  private fsRoot: string;
  private _main: Source;
  constructor(mainPath: string) {
    this.fsRoot = dirname(mainPath);
    this._main = {
      name: mainPath.substring(this.fsRoot.length),
      contents: Deno.readTextFileSync(mainPath),
    };
  }

  main(): Source {
    return this._main;
  }

  resolveSource(specifier: string): Promise<Source | undefined> {
    if (specifier && specifier[0] === "/") {
      const absPath = join(
        this.fsRoot,
        specifier.substring(1, specifier.length),
      );
      return Promise.resolve({
        name: specifier,
        contents: Deno.readTextFileSync(absPath),
      });
    }
    return Promise.resolve(undefined);
  }
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
  const program = await engine.resolve(new CliProgram(options.main));
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
