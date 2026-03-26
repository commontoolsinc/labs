import { transformCfDirective } from "@commonfabric/ts-transformers";
import {
  injectCfHelpers,
  sourceUsesCfDirective,
  transformCfDirective,
} from "@commonfabric/ts-transformers";
import { RuntimeProgram } from "./types.ts";

export function pretransformProgram(
  program: RuntimeProgram,
  id: string,
): RuntimeProgram {
  program = transformInjectHelperModule(program);
  program = transformProgramWithPrefix(program, id);
  return program;
}

// For each source file in the program, replace
// a `/// <cts-enable />` directive line with an
// internal import statement for use by the AST transformer
// to provide access to helpers like `derive`, etc.
export function transformInjectHelperModule(
  program: RuntimeProgram,
): RuntimeProgram {
  const propagateHelpers = program.files.some((source) =>
    sourceUsesCfDirective(source.contents)
  );
  return {
    main: program.main,
    files: program.files.map((source) => ({
      name: source.name,
      contents: transformCfDirective(source.contents),
      contents: source.name.endsWith(".d.ts")
        ? source.contents
        : propagateHelpers
        ? sourceUsesCfDirective(source.contents)
          ? transformCfDirective(source.contents)
          : injectCfHelpers(source.contents)
        : transformCfDirective(source.contents),
    })),
    mainExport: program.mainExport,
  };
}

// Adds `id` as a prefix to all files in the program.
// Injects a new entry at root `/index.ts` to re-export
// the entry contents because otherwise `typescript`
// flattens the output, eliding the common prefix.
export function transformProgramWithPrefix(
  program: RuntimeProgram,
  id: string,
): RuntimeProgram {
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
