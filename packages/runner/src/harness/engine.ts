import { Recipe } from "../builder/types.ts";
import { Console } from "./console.ts";
import { Harness, HarnessedFunction } from "./harness.ts";
import {
  getTypeScriptEnvironmentTypes,
  InMemoryProgram,
  JsScript,
  Program,
  ProgramResolver,
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

  constructor(program: Program) {
    const modules = program.files.reduce((mod, file) => {
      mod[file.name] = file.contents;
      return mod;
    }, {} as Record<string, string>);
    super(program.main, modules);
  }

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

  // Resolve a `ProgramResolver` into a `Program`.
  async resolve(program: ProgramResolver): Promise<Program> {
    const { compiler } = await this.getInternals();
    return await compiler.resolveProgram(program, {
      runtimeModules: Engine.runtimeModuleNames(),
    });
  }

  // Compile and run a `Program`, returning the export default recipe.
  async run(
    program: Program,
    options: EngineProcessOptions = {},
  ): Promise<Recipe> {
    const { exports } = await this.process(program, options);

    if (exports && !("default" in exports)) {
      throw new Error("No default export found in compiled recipe.");
    }

    return exports!.default as Recipe;
  }

  // Compile and run a `Program` with options, returning the compiled
  // result and evaluated exports.
  async process(
    program: Program,
    options: EngineProcessOptions = {},
  ): Promise<{ exports?: object; output: JsScript }> {
    const resolver = new EngineProgramResolver(program);

    const { compiler, isolate, runtimeExports } = await this.getInternals();
    const resolvedProgram = await this.resolve(resolver);

    const compiled = await compiler.compile(resolvedProgram, {
      filename: options.filename ?? computeFilename(resolvedProgram),
      noCheck: options.noCheck,
      injectedScript: INJECTED_SCRIPT,
      runtimeModules: Engine.runtimeModuleNames(),
    });

    let exports;
    if (!options.noRun) {
      exports = isolate.execute(compiled).invoke(runtimeExports)
        .inner();
    }
    return { exports, output: compiled };
  }

  // Invokes a function that should've came from this isolate (unverifiable).
  // We use this to hook into the isolate's source mapping functionality.
  invoke(fn: () => any): any {
    // Scheduler dictates this is a synchronous function,
    // and if we have functions from this source, this should already
    // be set up.
    // Some tests invoke values outside of this isolate, so just
    // execute and return if internals have not been initialized.
    if (!this.internals) {
      return fn();
    }
    return this.internals.isolate.value(fn).invoke().inner();
  }

  getInvocation(source: string): HarnessedFunction {
    return eval(source);
  }

  // Returns a map of runtime module types.
  static getRuntimeModuleTypes() {
    return RuntimeModules.getTypes();
  }

  static getEnvironmentTypes() {
    return getTypeScriptEnvironmentTypes();
  }

  static runtimeModuleNames() {
    return [...RuntimeModules.RuntimeModuleIdentifiers];
  }

  private async getInternals(): Promise<Internals> {
    if (!this.internals) {
      this.internals = await this.initialize();
    }
    return this.internals;
  }
}

function computeFilename(program: Program): string {
  const source = [
    program.main,
    ...program.files.filter(({ name }) => !name.endsWith(".d.ts")),
  ];
  return merkleReference.refer(source).toString() + ".tsx";
}
