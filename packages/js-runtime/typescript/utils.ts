import { cache } from "@commontools/static";

export const getTypeLibs = (() => {
  let cached: Record<string, string> | undefined;
  return async (): Promise<Record<string, string>> => {
    if (cached) {
      return cached;
    }
    const es2023 = await cache.getText("types/es2023.d.ts");
    cached = { es2023 };
    return cached;
  };
})();
