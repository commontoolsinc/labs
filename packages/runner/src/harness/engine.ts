import { Recipe } from "@commontools/builder";
import { Console } from "./console.ts";
import { Harness, HarnessedFunction } from "./harness.ts";
import {
  getTypeScriptEnvironmentTypes,
  InMemoryProgram,
  Program,
  Source,
  TypeScriptCompiler,
  UnsafeEvalIsolate,
  UnsafeEvalRuntime,
} from "@commontools/js-runtime";
import * as RuntimeModules from "./runtime-modules.ts";
import { IRuntime } from "../runtime.ts";
import * as merkleReference from "merkle-reference";

const RUNTIME_ENGINE_CONSOLE_HOOK = "RUNTIME_ENGINE_CONSOLE_HOOK";
const INJECTED_SCRIPT =
  `const console = globalThis.${RUNTIME_ENGINE_CONSOLE_HOOK};`;

declare global {
  var [RUNTIME_ENGINE_CONSOLE_HOOK]: any;
}

export interface EngineProcessOptions {
  noCheck?: boolean;
  noRun?: boolean;
  filename?: string;
}

// Extends a TypeScript program with 3P module types, if referenced.
export class EngineProgramResolver extends InMemoryProgram {
  private runtimeModuleTypes: Record<string, string> | undefined;

  // Add `.d.ts` files for known supported 3P modules.
  override async resolveSource(
    identifier: string,
  ): Promise<Source | undefined> {
    if (identifier.endsWith(".d.ts")) {
      const origSource = identifier.substring(0, identifier.length - 5);
      if (
        RuntimeModules.isRuntimeModuleIdentifier(origSource)
      ) {
        if (!this.runtimeModuleTypes) {
          this.runtimeModuleTypes = await Engine.getRuntimeModuleTypes();
        }
        if (
          origSource in this.runtimeModuleTypes &&
          this.runtimeModuleTypes[origSource]
        ) {
          return {
            name: identifier,
            contents: this.runtimeModuleTypes[origSource],
          };
        }
      }
    }
    return super.resolveSource(identifier);
  }
}

interface Internals {
  compiler: TypeScriptCompiler;
  runtime: UnsafeEvalRuntime;
  isolate: UnsafeEvalIsolate;
  runtimeExports: Record<string, any> | undefined;
}

export class Engine extends EventTarget implements Harness {
  private internals: Internals | undefined;
  private ctRuntime: IRuntime;
  constructor(ctRuntime: IRuntime) {
    super();
    this.ctRuntime = ctRuntime;
    // We install our console shim globally so that it can be referenced
    // by the eval script scope.
    globalThis[RUNTIME_ENGINE_CONSOLE_HOOK] = new Console(this);
  }

  async initialize() {
    const environmentTypes = await Engine.getEnvironmentTypes();
    const compiler = new TypeScriptCompiler(environmentTypes);
    const runtime = new UnsafeEvalRuntime();
    const isolate = runtime.getIsolate("");
    const runtimeExports = await RuntimeModules.getExports(this.ctRuntime);
    return { compiler, runtime, isolate, runtimeExports };
  }

  runSingle(
    source: string,
    options: EngineProcessOptions = {},
  ): Promise<Recipe> {
    return this.run("/main.tsx", { "/main.tsx": source }, options);
  }

  async run(
    entry: string,
    sources: Record<string, string>,
    options: EngineProcessOptions,
  ): Promise<Recipe> {
    const { exports } = await this.process(
      new EngineProgramResolver(entry, sources),
      options,
    );
    if (exports && !("default" in exports)) {
      throw new Error("No default export found in compiled recipe.");
    }
    return exports.default;
  }

  // Lower level API for processing source code.
  async process(program: EngineProgramResolver, options: EngineProcessOptions) {
    if (!this.internals) {
      this.internals = await this.initialize();
    }
    const { compiler, isolate, runtimeExports } = this.internals;
    const runtimeModules = [...RuntimeModules.RuntimeModuleIdentifiers];

    const resolvedProgram = await compiler.resolveProgram(program, {
      runtimeModules,
    });

    const compiled = await compiler.compile(resolvedProgram, {
      filename: options.filename ?? computeFilename(resolvedProgram),
      noCheck: options.noCheck,
      injectedScript: INJECTED_SCRIPT,
      runtimeModules,
    });

    let exports;
    if (!options.noRun) {
      exports = isolate.execute(compiled).invoke(runtimeExports)
        .inner();
    }
    return { exports, output: compiled };
  }

  getInvocation(source: string): HarnessedFunction {
    return eval(source);
  }

  mapStackTrace(stack: string): string {
    //return mapSourceMapsOnStacktrace(stack);
    return stack;
  }

  // Returns a map of runtime module types.
  static getRuntimeModuleTypes() {
    return RuntimeModules.getTypes();
  }

  static getEnvironmentTypes() {
    return getTypeScriptEnvironmentTypes();
  }
}

function computeFilename(program: Program): string {
  const source = [
    program.entry,
    ...program.files.filter(({ name }) => !name.endsWith(".d.ts")),
  ];
  return merkleReference.refer(source).toString() + ".tsx";
}
