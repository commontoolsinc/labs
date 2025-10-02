import { Recipe } from "../builder/types.ts";
import { Console } from "./console.ts";
import {
  Harness,
  HarnessedFunction,
  RuntimeProgram,
  TypeScriptHarnessProcessOptions,
} from "./types.ts";
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
import { CommonToolsTransformerPipeline } from "@commontools/ts-transformers";
import * as RuntimeModules from "./runtime-modules.ts";
import { IRuntime } from "../runtime.ts";
import * as merkleReference from "merkle-reference";
import { StaticCache } from "@commontools/static";

const RUNTIME_ENGINE_CONSOLE_HOOK = "RUNTIME_ENGINE_CONSOLE_HOOK";
const INJECTED_SCRIPT =
  `const console = globalThis.${RUNTIME_ENGINE_CONSOLE_HOOK};`;

declare global {
  var [RUNTIME_ENGINE_CONSOLE_HOOK]: any;
}

type Exports = Record<string, any>;

// Extends a TypeScript program with 3P module types, if referenced.
export class EngineProgramResolver extends InMemoryProgram {
  private runtimeModuleTypes: Record<string, string> | undefined;
  private cache: StaticCache;
  constructor(program: Program, cache: StaticCache) {
    const modules = program.files.reduce((mod, file) => {
      mod[file.name] = file.contents;
      return mod;
    }, {} as Record<string, string>);
    super(program.main, modules);
    this.cache = cache;
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
          this.runtimeModuleTypes = await Engine.getRuntimeModuleTypes(
            this.cache,
          );
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
  // Callback will be called with a map of exported values to `RuntimeProgram`
  // after compilation and initial eval and before compilation returns, so
  // before any e.g. recipe would be instantiated.
  exportsCallback: (exports: Map<any, RuntimeProgram>) => void;
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
    const environmentTypes = await Engine.getEnvironmentTypes(
      this.ctRuntime.staticCache,
    );
    const compiler = new TypeScriptCompiler(environmentTypes);
    const runtime = new UnsafeEvalRuntime();
    const isolate = runtime.getIsolate("");
    const { runtimeExports, exportsCallback } = await RuntimeModules.getExports(
      this.ctRuntime,
    );
    return { compiler, runtime, isolate, runtimeExports, exportsCallback };
  }

  // Resolve a `ProgramResolver` into a `Program`.
  async resolve(program: ProgramResolver): Promise<RuntimeProgram> {
    const { compiler } = await this.getInternals();
    return await compiler.resolveProgram(program, {
      runtimeModules: Engine.runtimeModuleNames(),
    });
  }

  // Compile and run a `Program`, returning the export default recipe.
  async run(
    program: RuntimeProgram,
    options: TypeScriptHarnessProcessOptions = {},
  ): Promise<Recipe> {
    const { main: exports, exportMap: _ } = await this.process(
      program,
      options,
    );

    const exportName = program.mainExport ?? "default";
    if (exports && !(exportName in exports)) {
      throw new Error(`No "${exportName}" export found in compiled recipe.`);
    }

    return exports![exportName] as Recipe;
  }

  // Compile and run a `Program` with options, returning the compiled
  // result and evaluated exports.
  async process(
    program: RuntimeProgram,
    options: TypeScriptHarnessProcessOptions = {},
  ): Promise<
    { main?: Exports; exportMap?: Record<string, Exports>; output: JsScript }
  > {
    const id = options.identifier ?? computeId(program);
    const filename = options.filename ?? `${id}.js`;
    const mappedProgram = mapPrefixProgramFiles(program, id);
    const resolver = new EngineProgramResolver(
      mappedProgram,
      this.ctRuntime.staticCache,
    );

    const { compiler, isolate, runtimeExports, exportsCallback } = await this
      .getInternals();
    const resolvedProgram = await this.resolve(resolver);
    const output = await compiler.compile(resolvedProgram, {
      filename,
      noCheck: options.noCheck,
      injectedScript: INJECTED_SCRIPT,
      runtimeModules: Engine.runtimeModuleNames(),
      bundleExportAll: true,
      getTransformedProgram: options.getTransformedProgram,
      beforeTransformers: (program) =>
        new CommonToolsTransformerPipeline().toFactories(program),
    });

    if (!options.noRun) {
      const result = isolate.execute(output).invoke(runtimeExports)
        .inner();
      if (
        result && typeof result === "object" && "main" in result &&
        "exportMap" in result
      ) {
        const main = result.main as Exports;
        const exportMap = result.exportMap as Record<string, Exports>;

        // Create a map from exported values to `RuntimeProgram` that can
        // generate them and pass to the callback from the exports.
        const exportsByValue = new Map<any, RuntimeProgram>();
        const prefix = `/${id}`;
        for (let [fileName, exports] of Object.entries(exportMap)) {
          if (fileName.startsWith(prefix)) {
            fileName = fileName.substring(prefix.length);
          }
          for (const [exportName, exportValue] of Object.entries(exports)) {
            exportsByValue.set(exportValue, {
              main: fileName,
              mainExport: exportName,
              // TODO(seefeld): Sending all `program.files` is sub-optimal, as
              // it is the super set of files actually needed by main. We should
              // only send the files actually needed by main.
              files: program.files,
            });
          }
        }
        exportsCallback(exportsByValue);

        return { output, main, exportMap };
      }
    }
    return { output };
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
  static getRuntimeModuleTypes(cache: StaticCache) {
    return RuntimeModules.getTypes(cache);
  }

  static getEnvironmentTypes(cache: StaticCache) {
    return getTypeScriptEnvironmentTypes(cache);
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

function computeId(program: Program): string {
  const source = [
    program.main,
    ...program.files.filter(({ name }) => !name.endsWith(".d.ts")),
  ];
  return merkleReference.refer(source).toString();
}

// Adds `id` as a prefix to all files in the program.
// Injects a new entry at root `/index.ts` to re-export
// the entry contents because otherwise `typescript`
// flattens the output, eliding the common prefix.
function mapPrefixProgramFiles(program: RuntimeProgram, id: string): Program {
  const main = program.main;
  const exportNameds = `export * from "${prefix(main, id)}";`;
  const exportDefault = `export { default } from "${prefix(main, id)}";`;
  const hasDefault = !program.mainExport || program.mainExport === "default";
  const files = [
    ...program.files.map((source) => ({
      name: prefix(source.name, id),
      contents: source.contents,
    })),
    {
      name: `/index.ts`,
      contents: `${exportNameds}${hasDefault ? `\n${exportDefault}` : ""}`,
    },
  ];
  return {
    main: `/index.ts`,
    files,
  };
}

function prefix(filename: string, id: string): string {
  return `/${id}${filename}`;
}
