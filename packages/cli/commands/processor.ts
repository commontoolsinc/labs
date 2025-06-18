import { RunCommand } from "../interface.ts";
import { type Source } from "@commontools/js-runtime";
import { Engine, EngineProgramResolver, Runtime } from "@commontools/runner";
import { basename, dirname, join } from "@std/path";

async function createRuntime() {
  const { Runtime } = await import("@commontools/runner");
  const { StorageManager } = await import(
    "@commontools/runner/storage/cache.deno"
  );
  const { Identity } = await import("@commontools/identity");
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

export class Processor {
  async run(command: RunCommand): Promise<any> {
    const filename = command.filename
      ? basename(command.filename)
      : command.output
      ? basename(command.output)
      : undefined;
    const program = new CliProgram(command.entry);
    const engine = new Engine(await createRuntime());
    const { output, exports } = await engine.process(program, {
      noCheck: command.noCheck,
      noRun: command.noRun,
      filename,
    });

    if (command.output) {
      await Deno.writeTextFile(command.output, output.js);
    }
    return command.noRun ? undefined : exports;
  }
}
