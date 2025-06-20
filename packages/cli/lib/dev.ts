import { JsScript, type Source } from "@commontools/js-runtime";
import { Identity } from "@commontools/identity";
import { Engine, EngineProgramResolver, Runtime } from "@commontools/runner";
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
class CliProgram extends EngineProgramResolver {
  private fsRoot: string;
  private _entry: Source;
  constructor(entryPath: string) {
    super(entryPath, {});
    this.fsRoot = dirname(entryPath);
    this._entry = {
      name: entryPath.substring(this.fsRoot.length),
      contents: Deno.readTextFileSync(entryPath),
    };
  }

  override entry(): Source {
    return this._entry;
  }

  override resolveSource(specifier: string): Promise<Source | undefined> {
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
    return super.resolveSource(specifier);
  }
}

export interface ProcessOptions {
  entry: string;
  run: boolean;
  check: boolean;
  output?: string;
  filename?: string;
}

export async function process(
  options: ProcessOptions,
): Promise<{ output: JsScript; exports: any }> {
  const filename = options.filename
    ? basename(options.filename)
    : options.output
    ? basename(options.output)
    : undefined;
  const program = new CliProgram(options.entry);
  const engine = new Engine(await createRuntime());
  const { output, exports } = await engine.process(program, {
    noCheck: !options.check,
    noRun: !options.run,
    filename,
  });

  if (options.output) {
    await Deno.writeTextFile(options.output, output.js);
  }
  return { output, exports };
}
