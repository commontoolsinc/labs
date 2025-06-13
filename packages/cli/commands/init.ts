import { Engine } from "@commontools/runner";
import { Command } from "../interface.ts";
import { join } from "@std/path/join";

const tsConfig = {
  "compilerOptions": {
    // Disable all libraries. Strictly only use
    // types provided by the runtime.
    "noLib": true,
    "types": ["ct-env"],
    "typeRoots": ["./.ct-types"],
    // This is specifically for `turndown` which has a
    // strange way of exporting itself -- TBD if
    // this needs to be added to the runtime TSC config,
    // but maybe that's handled with the __esDefault flag?
    "allowSyntheticDefaultImports": true,
    "target": "ES2023",
    "jsx": "react-jsx",
    "strictNullChecks": true,
    "strictFunctionTypes": true,
  },
  "exclude": [
    "node_modules",
    "**/node_modules/*",
  ],
};

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
    JSON.stringify(tsConfig, null, 2),
  );
}
