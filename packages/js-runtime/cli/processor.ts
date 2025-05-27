import * as path from "@std/path";
import { Command, CommandType, RunCommand } from "./interface.ts";
import {
  bundle,
  getTypeLibs,
  TypeScriptCompiler,
  UnsafeEvalRuntime,
} from "../mod.ts";

export class Processor {
  async run(command: RunCommand): Promise<any> {
    const compiler = new TypeScriptCompiler(await getTypeLibs());
    const compiled = compiler.compile(command.source);
    const bundled = bundle({
      source: compiled,
      filename: "out.js",
      runtimeDependencies: true,
    });
    const runtime = new UnsafeEvalRuntime();
    const isolate = runtime.getIsolate("");
    const exports = isolate.execute(bundled).invoke({});
    return exports.inner();
  }
}