import * as path from "@std/path";
import { Command, CommandType, RunCommand } from "./interface.ts";
import { getTypeLibs, TypeScriptCompiler, UnsafeEvalRuntime } from "../mod.ts";

export class Processor {
  async run(command: RunCommand): Promise<any> {
    const compiler = new TypeScriptCompiler(await getTypeLibs());
    const compiled = compiler.compile(command.source, {
      noCheck: !!command.noCheck,
      filename: command.out ? path.basename(command.out) : undefined,
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
