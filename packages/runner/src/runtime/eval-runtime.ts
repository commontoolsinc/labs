import { Recipe } from "../../../builder/src/index.ts";
import { mapSourceMapsOnStacktrace, tsToExports } from "./local-build.ts";
import { Runtime, RuntimeFunction } from "./runtime.ts";
import { Console } from "./console.ts";

const RUNTIME_CONSOLE_HOOK = "RUNTIME_CONSOLE_HOOK";
declare global {
  var [RUNTIME_CONSOLE_HOOK]: any;
}

export class UnsafeEvalRuntime extends EventTarget implements Runtime {
  constructor() {
    super();
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
    });
    if (!("default" in exports)) {
      throw new Error("No default export found in compiled recipe.");
    }
    return exports.default;
  }
  getInvocation(source: string): RuntimeFunction {
    return eval(source);
  }
  mapStackTrace(stack: string): string {
    return mapSourceMapsOnStacktrace(stack);
  }
}
