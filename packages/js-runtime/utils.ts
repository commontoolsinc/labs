import { cache } from "@commontools/static";
import { isSourceMap, SourceMap } from "./interface.ts";

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

// Parses string as a `SourceMap`, or throws if unable.
export function parseSourceMap(stringMap: string): SourceMap {
  const sourceMap = JSON.parse(stringMap);
  if (sourceMap && "version" in sourceMap) {
    // TypeScript correctly generates `version` as an integer,
    // but the `source-map-js` library's `RawSourceMap` we use
    // elsewhere expects `version` to be a string.
    sourceMap.version = `${sourceMap.version}`;
  }
  if (!isSourceMap(sourceMap)) {
    throw new Error(
      `Could not parse source map: ${JSON.stringify(sourceMap, null, 2)}`,
    );
  }
  return sourceMap;
}
