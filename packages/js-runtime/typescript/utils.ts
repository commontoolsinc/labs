import { getAssetText } from "@commontools/assets";

export type TypeScriptAPI = typeof import("typescript");

export const getTSCompiler = (() => {
  let ts: Promise<TypeScriptAPI> | void;
  return function getTSCompiler(): Promise<TypeScriptAPI> {
    if (ts) {
      return ts;
    }
    ts = import("typescript").then((exports) => exports.default);
    return ts;
  };
})();

// Returns a string payload of "es2023.d.ts", loading differently
// depending on the environment.
export const getTypeLibs = (() => {
  let cached: string | undefined;
  return async (): Promise<string> => {
    if (cached) {
      return cached;
    }
    cached = await getAssetText("es2023.d.ts");
    return cached;
  };
})();
