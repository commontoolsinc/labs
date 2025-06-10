import { cache } from "@commontools/static";
import { Command } from "../interface.ts";
import { join } from "@std/path/join";

const tsConfig = {
  "compilerOptions": {
    "types": ["commontoolsenv"],
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
  const types = {
    "commontools": await cache.getText(
      "types/commontools.d.ts",
    ),
    "commontoolsenv": await cache.getText(
      "types/dom.d.ts",
    ),
    "react/jsx-runtime": jsxRuntime,
  };

  for (const [name, typeDef] of Object.entries(types)) {
    const path = join(cwd, "node_modules", "@types", name);
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
