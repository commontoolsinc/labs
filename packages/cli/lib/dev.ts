import {
  collectImportSpecifiers,
  FileSystemProgramResolver,
  type Program,
  type ProgramResolver,
  resolveImportSpecifier,
  type Source,
} from "@commonfabric/js-compiler";
import { TARGET } from "@commonfabric/js-compiler/typescript";
import { Identity } from "@commonfabric/identity";
import {
  experimentalOptionsFromEnv,
  type MemorySpace,
  parseFabricRef,
  Runtime,
  runtimePresets,
  type RuntimeProgram,
} from "@commonfabric/runner";

const FABRIC_IMPORTS_REQUIRE_SPACE_MESSAGE =
  "fabric imports require a space context (options.fabricImports)";

export async function createRuntime() {
  const { StorageManager } = await import(
    "@commonfabric/runner/storage/cache.deno"
  );
  const storageManager = StorageManager.emulate({
    as: await Identity.fromPassphrase("builder"),
  });
  // Shared first-party posture (CT-1814); emulated storage is the local-dev
  // delta and stays visible here.
  return new Runtime(runtimePresets.localDev({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: experimentalOptionsFromEnv(Deno.env.get),
  }));
}

export interface ProcessOptions {
  main: string;
  rootPath?: string;
  run: boolean;
  check: boolean;
  output?: string;
  showTransformed?: boolean;
  mainExport?: string;
  verboseErrors?: boolean;
  space?: string;
}

export async function process(
  options: ProcessOptions,
): Promise<{ output: string; main?: Record<string, unknown> }> {
  const runtime = await createRuntime();
  // Compile/evaluate through the runtime's OWN harness, not a second Engine.
  // Verified-load registration, source maps, and module hashes all live on the
  // engine that evaluates the bundle; the runner and the builder's source-
  // location annotation consult `runtime.harness`. A separate Engine splits
  // that state, so `fn.src` stays a raw bundle coordinate and CFC verified-
  // binding identities (writeAuthorizedBy) fail under enforcement.
  const engine = runtime.harness;
  const resolver = new FileSystemProgramResolver(
    options.main,
    options.rootPath,
  );
  let program: RuntimeProgram;
  if (options.space) {
    program = await collectLocalProgram(resolver, { fabricImports: "allow" });
  } else {
    // engine.resolve fails fabric specifiers as generic unresolved modules;
    // scan first so they get the friendlier requires-a-space message.
    await collectLocalProgram(resolver, { fabricImports: "reject" });
    program = await engine.resolve(resolver);
  }
  if (options.mainExport) {
    program.mainExport = options.mainExport;
  }
  const getTransformedProgram = options.showTransformed
    ? renderTransformed
    : undefined;
  const { id, graph, mainSpecifier, resolvedPins } = await engine
    .compileToRecordGraph(
      program,
      {
        noCheck: !options.check,
        getTransformedProgram,
        verboseErrors: options.verboseErrors,
        fabricImports: options.space
          ? {
            space: options.space as MemorySpace,
            allowUnpinned: true,
          }
          : undefined,
      },
    );
  for (const pin of resolvedPins) {
    console.error(
      `resolved ${pin.specifier} -> @${pin.resolvedIdentity} (not pinned; deploy or run cf deps update to pin)`,
    );
  }

  // Concatenated per-module compiled bodies (the same composition the SES
  // loader evaluates), for inspection via --output.
  const output = [...graph.compiledBodies.entries()]
    .map(([specifier, body]) => `// ${specifier}\n${body}`)
    .join("\n");
  if (options.output) {
    await Deno.writeTextFile(options.output, output);
  }

  if (!options.run) {
    return { output };
  }

  const { main } = engine.evaluateRecordGraph(
    id,
    graph,
    mainSpecifier,
    program.files,
  );
  return { output, main };
}

function renderTransformed(program: Program) {
  for (const { contents, name } of program.files) {
    console.log(`// transformed: ${name}`);
    console.log(contents);
  }
}

/**
 * Walk a local resolver's import graph into a Program, leaving fabric (cf:)
 * specifiers to the engine's FabricAwareResolver. Malformed cf: specifiers
 * fail here with their parse error; valid ones either pass through
 * (`"allow"`) or trigger the requires-a-space error (`"reject"`, for compiles
 * with no fabric context). Shared by `cf dev`/`cf check` and `cf deps`.
 */
export async function collectLocalProgram(
  resolver: ProgramResolver,
  options: { fabricImports: "allow" | "reject" },
): Promise<Program> {
  const main = await resolver.main();
  const pending = [main];
  const seen = new Set<string>();
  const files: Source[] = [];

  while (pending.length > 0) {
    const source = pending.shift()!;
    if (seen.has(source.name)) continue;
    seen.add(source.name);
    files.push(source);

    for (const specifier of collectImportSpecifiers(source, TARGET)) {
      if (specifier.startsWith("cf:")) {
        parseFabricRef(specifier); // malformed → FabricRefError, here
        if (options.fabricImports === "reject") {
          throw new Error(FABRIC_IMPORTS_REQUIRE_SPACE_MESSAGE);
        }
        continue;
      }

      const identifier = resolveImportSpecifier(specifier, source);
      if (!isFileSystemSourceIdentifier(identifier) || seen.has(identifier)) {
        continue;
      }
      const resolved = await resolver.resolveSource(identifier);
      if (resolved !== undefined) pending.push(resolved);
    }
  }

  return { main: main.name, files };
}

function isFileSystemSourceIdentifier(
  identifier: string,
): identifier is Source["name"] {
  return identifier.startsWith("/");
}
