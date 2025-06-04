import { RunCommand } from "./interface.ts";
import {
  getTypeLibs,
  ProgramGraph,
  Source,
  TypeScriptCompiler,
  UnsafeEvalRuntime,
} from "../mod.ts";
import { basename, dirname, join } from "@std/path";

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
    const program = new CliProgram(command.entry);
    const compiler = new TypeScriptCompiler(await getTypeLibs());
    const compiled = compiler.compile(program, {
      noCheck: !!command.noCheck,
      filename: command.out ? basename(command.out) : undefined,
    });

    if (command.noRun) {
      return;
    }

    if (command.out) {
      await Deno.writeTextFile(command.out, compiled.js);
    }

    const runtime = new UnsafeEvalRuntime();
    const isolate = runtime.getIsolate("");
    const exports = isolate.execute(compiled).invoke();
    return exports.inner();
  }
}
