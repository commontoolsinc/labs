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
import { type MemorySpace, Runtime } from "@commonfabric/runner";
import { experimentalOptionsFromEnv } from "./utils.ts";
import { renderPinRewrite } from "./fabric-deps.ts";

const FABRIC_IMPORTS_REQUIRE_SPACE_MESSAGE =
  "fabric imports require a space context (options.fabricImports)";

async function createRuntime() {
  const { StorageManager } = await import(
    "@commonfabric/runner/storage/cache.deno"
  );
  const storageManager = StorageManager.emulate({
    as: await Identity.fromPassphrase("builder"),
  });
  return new Runtime({
    storageManager,
    experimental: experimentalOptionsFromEnv(),
    apiUrl: new URL(import.meta.url),
  });
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
  const program = options.space
    ? await resolveLocalProgramAllowingFabric(resolver)
    : await engine.resolve(await assertNoFabricImportsWithoutSpace(resolver));
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
      `${
        renderPinRewrite({
          file: program.main,
          line: 0,
          pinned: `${pin.specifier}@${pin.resolvedIdentity}`,
          specifier: pin.specifier,
          resolvedIdentity: pin.resolvedIdentity,
        })
      } (not pinned - deploy or run cf deps update)`,
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

async function assertNoFabricImportsWithoutSpace(
  resolver: ProgramResolver,
): Promise<ProgramResolver> {
  const main = await resolver.main();
  const pending = [main];
  const seen = new Set<string>();

  while (pending.length > 0) {
    const source = pending.shift()!;
    if (seen.has(source.name)) continue;
    seen.add(source.name);

    for (const specifier of collectImportSpecifiers(source, TARGET)) {
      if (isFabricImportSpecifier(specifier)) {
        throw new Error(FABRIC_IMPORTS_REQUIRE_SPACE_MESSAGE);
      }

      const identifier = resolveImportSpecifier(specifier, source);
      if (!isFileSystemSourceIdentifier(identifier) || seen.has(identifier)) {
        continue;
      }
      const resolved = await resolver.resolveSource(identifier);
      if (resolved !== undefined) pending.push(resolved);
    }
  }
  return resolver;
}

async function resolveLocalProgramAllowingFabric(
  resolver: ProgramResolver,
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
      if (isFabricImportSpecifier(specifier)) continue;

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

function isFabricImportSpecifier(specifier: string): boolean {
  return specifier.startsWith("cf:");
}

function isFileSystemSourceIdentifier(
  identifier: string,
): identifier is Source["name"] {
  return identifier.startsWith("/");
}
