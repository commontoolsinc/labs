import { Engine } from "@commontools/runner";
import { Command } from "../interface.ts";
import { join } from "@std/path/join";
import { getCompilerOptions } from "@commontools/js-runtime/typescript";

function createTsConfig() {
  const filterProps = [
    "jsx",
    "jsxFactory",
    "jsxFragmentFactory",
    // Should migrate runtime options to also use `noLib` and
    // manually provide types
    "lib",
    // External tools will resolve on their own
    "noResolve",
    // "target" tsc lib types are different than tsconfig types
    "target",
    // "module" tsc lib types are different than tsconfig types
    "module",
  ];
  const compilerOptions = Object.entries(getCompilerOptions()).reduce(
    (output, [key, value]) => {
      if (!filterProps.includes(key)) {
        output[key] = value;
      }
      return output;
    },
    {} as Record<string, any>,
  );

  return {
    "compilerOptions": Object.assign({}, compilerOptions, {
      // Disable all libraries. Strictly only use
      // types provided by the runtime.
      "noLib": true,
      "types": ["ct-env"],
      "typeRoots": ["./.ct-types"],

      "jsx": "react-jsx",
      "target": "ES2023",
      "module": "amd",

      // This is specifically for `turndown` which has a
      // strange way of exporting itself -- TBD if
      // this needs to be added to the runtime TSC config,
      // but maybe that's handled with the __esDefault flag?
      "allowSyntheticDefaultImports": true,
      // TBD why this is needed here and not in our runtime options
      "allowImportingTsExtensions": true,
      // If we allowImportingTsExtensions, then we alos need noEmit
      "noEmit": true,
    }),
    "exclude": [
      "node_modules",
      "**/node_modules/*",
    ],
  };
}

// Standalone typescript needs this -- code executed
// in runtime uses the global JSX.IntrinsicElements declaration
// used in `commontools` types.
const jsxRuntime = `declare module "react/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: any;
    }
  }
}
`;

// Creates the necessary type definitions
// in CWD so that recipes can be successfully parsed
// and typed against a typical typescript environment in e.g. VSCode.
//
// This is achieved by creating a `node_modules/@types/` directory
// containing types for the imported stdlib (`commontools`), the
// implicitly loaded jsx-runtime (`react/jsx-runtime`) and the
// environment types (`commontoolsenv`) loaded by the `tsconfig.json`.
export async function initWorkspace(command: Command) {
  const { cwd } = command;
  const runtimeModuleTypes = await Engine.getRuntimeModuleTypes();
  const envTypes = await Engine.getEnvironmentTypes();

  // Concatenate all environment types into a single "lib",
  // which will be referred to as "ct-env" in the typescript config
  const ctEnv = Object.values(envTypes).reduce((env, types) => {
    env += `${env}\n${types}`;
    return env;
  }, "");

  const types = {
    "commontools": runtimeModuleTypes.commontools,
    "turndown": runtimeModuleTypes.turndown,
    "dom-parser": runtimeModuleTypes["dom-parser"],
    "ct-env": ctEnv,
    "react/jsx-runtime": jsxRuntime,
  };

  for (const [name, typeDef] of Object.entries(types)) {
    const path = join(cwd, ".ct-types", name);
    await Deno.mkdir(path, {
      recursive: true,
    });
    await Deno.writeTextFile(join(path, "index.d.ts"), typeDef);
  }
  await Deno.writeTextFile(
    join(cwd, "tsconfig.json"),
    JSON.stringify(createTsConfig(), null, 2),
  );
}
