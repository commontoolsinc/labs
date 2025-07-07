import { cache } from "@commontools/static";

// Returns an object mapping typescript lib name
// to a string of standalone .d.ts content.
// Includes the following types:
// * "es2023"
// * "dom"
export const getTypeScriptEnvironmentTypes = (() => {
  let cached: Record<string, string> | undefined;
  return async (): Promise<Record<string, string>> => {
    if (cached) {
      return cached;
    }
    const es2023 = await cache.getText("types/es2023.d.ts");
    const jsx = await cache.getText("types/jsx.d.ts");
    const dom = await cache.getText("types/dom.d.ts");

    cached = {
      es2023,
      // Combine jsx types in our "DOM" types -- having jsx types
      // in commontools module definition was a problem as it's imported
      // multiple times when shimming older modules with the "commontools" types.
      dom: `${dom}\n${jsx}`,
    };
    return cached;
  };
})();
