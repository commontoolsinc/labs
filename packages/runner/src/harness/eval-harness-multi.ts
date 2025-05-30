import { Recipe } from "@commontools/builder";
import { Console } from "./console.ts";
import { Harness, HarnessedFunction } from "./harness.ts";
import {
  bundle,
  getTypeLibs,
  TsArtifact,
  TypeScriptCompiler,
  UnsafeEvalIsolate,
  UnsafeEvalRuntime,
} from "@commontools/js-runtime";
import * as commonHtml from "@commontools/html";
import * as commonBuilder from "@commontools/builder";
import * as zod from "zod";
import * as zodToJsonSchema from "zod-to-json-schema";
import * as merkleReference from "merkle-reference";
import turndown from "turndown";

function createLibExports(): Record<string, object> {
  return {
    "@commontools/html": commonHtml,
    "@commontools/builder": commonBuilder,
    "zod": zod,
    "merkle-reference": merkleReference,
    "zod-to-json-schema": zodToJsonSchema,
    "turndown": turndown,
  };
}

const MULTI_RUNTIME_CONSOLE_HOOK = "MULTI_RUNTIME_CONSOLE_HOOK";
declare global {
  var [MULTI_RUNTIME_CONSOLE_HOOK]: any;
}

interface Internals {
  compiler: TypeScriptCompiler;
  runtime: UnsafeEvalRuntime;
  isolate: UnsafeEvalIsolate;
}

export class UnsafeEvalRuntimeMulti extends EventTarget implements Harness {
  private internals: Internals | undefined;
  constructor() {
    super();
    // We install our console shim globally so that it can be referenced
    // by the eval script scope.
    globalThis[MULTI_RUNTIME_CONSOLE_HOOK] = new Console(this);
  }

  runSingle(source: string): Promise<Recipe> {
    return this.run({
      entry: "/main.tsx",
      files: [{ name: "/main.tsx", contents: source }],
    });
  }

  async run(source: TsArtifact): Promise<Recipe> {
    if (!this.internals) {
      const typeLibs = await getTypeLibs();
      const compiler = new TypeScriptCompiler(typeLibs);
      const runtime = new UnsafeEvalRuntime();
      const isolate = runtime.getIsolate("");
      this.internals = { compiler, runtime, isolate };
    }

    const { compiler, isolate } = this.internals;

    const injectedScript =
      `const console = globalThis.${RUNTIME_CONSOLE_HOOK};`;
    const compiled = compiler.compile(source);
    const bundled = bundle({
      source: compiled,
      injectedScript,
      filename: "out.js",
      runtimeDependencies: true,
    });
    const exports = isolate.execute(bundled).invoke(createLibExports()).inner();
    if (exports && !("default" in exports)) {
      throw new Error("No default export found in compiled recipe.");
    }
    return exports.default;
  }

  getInvocation(source: string): HarnessedFunction {
    return eval(source);
  }

  mapStackTrace(stack: string): string {
    //return mapSourceMapsOnStacktrace(stack);
    return stack;
  }
}
