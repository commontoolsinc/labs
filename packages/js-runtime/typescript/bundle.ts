import { SourceMap } from "../interface.ts";
import { getAMDLoader } from "./loader.ts";

const ENTRY = "$ENTRY";
const BUNDLE_PRE = stripNewLines(`
((runtimeDeps={}) => {
  const { define, require } = (${getAMDLoader.toString()})();
  for (const [name, dep] of Object.entries(runtimeDeps)) {
    define(name, ["exports"], exports => Object.assign(exports, dep));
  }`);
const BUNDLE_POST = stripNewLines(`
  return require("$ENTRY");
});
`);

export interface BundleAMDOutputConfig {
  // The AMD module to require and return in
  // the enclosing bundle. TypeScript's compiler
  // sets a filename of "/main.tsx" to "main".
  entryModule: string;
  // The concatenated source of multiple AMD "defines".
  source: string;
  // `source`'s source map.
  sourceMap: SourceMap;
  // The filename to use in the output sourceURL pragma.
  filename: string;
  // Extra script to minify and inject before `source`.
  injectedScript?: string;
}

export function bundleAMDOutput(config: BundleAMDOutputConfig): string {
  let output = "";
  // We want everything before `source` to be a single line as to not
  // modify the existing source map (other than the first line's columns,
  // which is AMD module boilerplate anyway).
  output += BUNDLE_PRE;
  if (config.injectedScript) output += stripNewLines(config.injectedScript);
  output += stripSourceMappingUrl(config.source) + "\n";
  output += BUNDLE_POST.replace(ENTRY, config.entryModule) + "\n";
  output += sourceMappingUrl(config.sourceMap);
  output += sourceUrl(config.filename);
  return output;
}

// Strip new lines
function stripNewLines(input: string): string {
  return input.replace(/\n/g, "");
}

// Strip existing `//# sourceMappingURL` pragmas.
function stripSourceMappingUrl(input: string): string {
  return input.split("\n").filter((line) =>
    !/^\/\/# sourceMappingURL/.test(line)
  ).join("\n");
}

// Returns a string of a JS `sourceMappingURL` comment, encoding
// an inline source map.
function sourceMappingUrl(sourceMap: SourceMap): string {
  const encodedMap = btoa(JSON.stringify(sourceMap));
  // ${"sourceMappingURL"} prevents confusion with this file's source map
  return `//# ${"sourceMappingURL"}=data:application/json;base64,${encodedMap}\n`;
}

// Returns a string of a JS `sourceURL` comment with provided filename.
function sourceUrl(filename: string): string {
  // ${"sourceURL"} prevents confusion with this file's source map
  return `//# ${"sourceURL"}=${filename}\n`;
}
