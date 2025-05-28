import { Recipe } from "@commontools/builder";
import { mapSourceMapsOnStacktrace, tsToExports } from "./local-build.ts";
import { Harness, HarnessFunction } from "./harness.ts";
import { Console } from "./console.ts";
import { type IRuntime } from "../runtime.ts";

const RUNTIME_CONSOLE_HOOK = "RUNTIME_CONSOLE_HOOK";
declare global {
  var [RUNTIME_CONSOLE_HOOK]: any;
}

export class UnsafeEvalHarness extends EventTarget implements Harness {
  readonly runtime: IRuntime;

  constructor(runtime: IRuntime) {
    super();
    this.runtime = runtime;
    // We install our console shim globally so that it can be referenced
    // by the eval script scope.
    globalThis[RUNTIME_CONSOLE_HOOK] = new Console(this);
  }
  // FIXME(ja): perhaps we need the errors?
  async compile(source: string): Promise<Recipe> {
    if (!source) {
      throw new Error("No source provided.");
    }
    const exports = await tsToExports(source, {
      injection: `const console = globalThis.${RUNTIME_CONSOLE_HOOK};`,
      runtime: this.runtime,
    });
    if (!("default" in exports)) {
      throw new Error("No default export found in compiled recipe.");
    }
    return exports.default;
  }
  getInvocation(source: string): HarnessFunction {
    return eval(source);
  }
  mapStackTrace(stack: string): string {
    return mapSourceMapsOnStacktrace(stack);
  }
}
