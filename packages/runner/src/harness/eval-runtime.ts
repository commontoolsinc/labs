import { Recipe } from "@commontools/builder";
import { CtRuntime, RuntimeFunction } from "./ct-runtime.ts";
import { type TsArtifact } from "@commontools/js-runtime";
import { mapSourceMapsOnStacktrace, tsToExports } from "./local-build.ts";
import { Console } from "./console.ts";

const RUNTIME_CONSOLE_HOOK = "RUNTIME_CONSOLE_HOOK";
declare global {
  var [RUNTIME_CONSOLE_HOOK]: any;
}

export class UnsafeEvalRuntime extends EventTarget implements CtRuntime {
  constructor() {
    super();
    // We install our console shim globally so that it can be referenced
    // by the eval script scope.
    globalThis[RUNTIME_CONSOLE_HOOK] = new Console(this);
  }

  runSingle(source: string): Promise<Recipe> {
    return this.run({
      entry: "/main.tsx",
      files: [{ name: "/main.tsx", contents: source }],
    });
  }

  async run(source: TsArtifact): Promise<Recipe> {
    const file = source.files.find(({ name }) => name === source.entry);
    if (!file) {
      throw new Error("Needs an entry source.");
    }

    const exports = await tsToExports(file.contents, {
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
