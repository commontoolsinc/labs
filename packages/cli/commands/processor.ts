import { RunCommand } from "../interface.ts";
import {
  getTypeLibs,
  ProgramGraph,
  Source,
  TypeScriptCompiler,
  UnsafeEvalRuntime,
} from "@commontools/js-runtime";
import { basename, dirname, join } from "@std/path";
import { cache } from "@commontools/static";

type RUNTIME_IDENTIFIER = "commontools";
const RUNTIME_TYPES: Record<RUNTIME_IDENTIFIER, string> = {
  "commontools": await cache.getText(
    "types/commontools.d.ts",
  ),
};

async function createRuntimeDependencies(): Promise<
  Record<RUNTIME_IDENTIFIER, any>
> {
  const { Runtime, StorageManager } = await import("@commontools/runner");
  const { createBuilder } = await import("@commontools/builder");
  const { Identity } = await import("@commontools/identity");
  const storageManager = StorageManager.emulate({
    as: await Identity.fromPassphrase("builder"),
  });
  const builder = createBuilder(
    new Runtime({ storageManager, blobbyServerUrl: import.meta.url }),
  );
  return {
    "commontools": builder,
  };
}

class CliProgram implements ProgramGraph {
  private fsRoot: string;
  private _entry: Source;
  constructor(entryPath: string) {
    this.fsRoot = dirname(entryPath);
    this._entry = {
      name: entryPath.substring(this.fsRoot.length),
      contents: Deno.readTextFileSync(entryPath),
    };
  }

  entry(): Source {
    return this._entry;
  }

  resolveSource(specifier: string): Source | undefined {
    if (specifier.endsWith(".d.ts")) {
      const bare = specifier.substring(0, specifier.length - 5);
      if (bare in RUNTIME_TYPES) {
        return {
          name: specifier,
          contents: RUNTIME_TYPES[bare as RUNTIME_IDENTIFIER],
        };
      }
    }
    if (specifier && specifier[0] === "/") {
      const absPath = join(
        this.fsRoot,
        specifier.substring(1, specifier.length),
      );
      return {
        name: specifier,
        contents: Deno.readTextFileSync(absPath),
      };
    }
    return undefined;
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
    const compiler = new TypeScriptCompiler(await getTypeLibs());
    const compiled = compiler.compile(program, {
      noCheck: command.noCheck,
      filename,
      runtimeModules: Object.keys(RUNTIME_TYPES),
    });

    if (command.output) {
      await Deno.writeTextFile(command.output, compiled.js);
    }

    if (command.noRun) {
      return;
    }

    const runtime = new UnsafeEvalRuntime();
    const isolate = runtime.getIsolate("");
    const exports = isolate.execute(compiled).invoke(
      await createRuntimeDependencies(),
    );
    return exports.inner();
  }
}
