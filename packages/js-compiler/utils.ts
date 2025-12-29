import { type StaticCache } from "@commontools/static";

// Returns an object mapping typescript lib name
// to a string of standalone .d.ts content.
// Includes the following types:
// * "es2023"
// * "jsx"
// * "dom"
//
// This is a module-level singleton that caches ~775KB of type definitions.
// Use getTypeScriptEnvironmentTypes.clear() to release memory in tests.
export const getTypeScriptEnvironmentTypes: {
  (cache: StaticCache): Promise<Record<string, string>>;
  clear: () => void;
} = (() => {
  let cached: Record<string, string> | undefined;
  const fn = async (cache: StaticCache): Promise<Record<string, string>> => {
    if (cached) {
      return cached;
    }
    const es2023 = await cache.getText("types/es2023.d.ts");
    const jsx = await cache.getText("types/jsx.d.ts");
    const dom = await cache.getText("types/dom.d.ts");

    cached = {
      es2023,
      dom,
      jsx,
    };
    return cached;
  };
  fn.clear = () => {
    cached = undefined;
  };
  return fn;
})();
