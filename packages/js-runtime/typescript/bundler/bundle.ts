import { SourceMap } from "../../interface.ts";
import { getAMDLoader } from "./amd-loader.ts";
import { encode } from "@commontools/utils/encoding";

const MAIN = "$MAIN";
const BUNDLE_PRE = stripNewLines(`
((runtimeDeps={}) => {
  const { define, require } = (${getAMDLoader.toString()})();
  globalThis.__CT_COMMONTOOLS = runtimeDeps.commontools;
  for (const [name, dep] of Object.entries(runtimeDeps)) {
    define(name, ["exports"], exports => Object.assign(exports, dep));
  }`);
const BUNDLE_POST = stripNewLines(`});`);

export interface BundleAMDOutputConfig {
  // The AMD module to require and return in
  // the enclosing bundle, like "/main.tsx".
  mainModule: string;
  // The concatenated source of multiple AMD "defines".
  source: string;
  // `source`'s source map.
  sourceMap: SourceMap;
  // The filename to use in the output sourceURL pragma.
  filename: string;
  // Extra script to minify and inject before `source`.
  injectedScript?: string;
  // If defined, the bundle evaluates to { main: MAINEXPORTS, exportMap: Record<string, Record<string, any>> }
  // containing all exported modules that are in the list.
  exportModuleExports?: string[];
}

export function bundleAMDOutput(config: BundleAMDOutputConfig): string {
  let output = "";
  // We want everything before `source` to be a single line as to not
  // modify the existing source map (other than the first line's columns,
  // which is AMD module boilerplate anyway).
  output += BUNDLE_PRE;
  if (config.injectedScript) output += stripNewLines(config.injectedScript);
  output += stripSourceMappingUrl(config.source) + "\n";
  output += returnValue(config);
  output += BUNDLE_POST + "\n";
  output += sourceMappingUrl(config.sourceMap);
  output += sourceUrl(config.filename);
  return output;
}

// We track module names rooted with `/`, like
// `/main.tsx`, `/utils/foo.ts`.
// The typescript output for AMD translates these
// into `main`, and `utils/foo`, stripping prefix `/`
// and the suffix extension. This could cause collisions
// with non-local files.
function mapModuleName(name: string): string {
  if (name.startsWith("/")) name = name.substring(1);
  if (
    name.endsWith(".tsx") ||
    name.endsWith(".ts") || name.endsWith(".jsx") || name.endsWith(".js")
  ) {
    name = name.substring(0, name.lastIndexOf("."));
  }
  return name;
}

function returnValue(
  { mainModule, exportModuleExports }: {
    mainModule: string;
    exportModuleExports?: string[];
  },
): string {
  let code = `return require("$MAIN");`;

  if (exportModuleExports) {
    const modExports = exportModuleExports.map((module) =>
      `exportMap["${module}"] = require("${mapModuleName(module)}");`
    ).join("");
    code = `
const main = require("$MAIN");
const exportMap = Object.create(null);
${modExports}
return { main, exportMap };`;
  }

  return stripNewLines(code).replace(MAIN, mapModuleName(mainModule));
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
  const encodedMap = btoaFix(JSON.stringify(sourceMap));
  // ${"sourceMappingURL"} prevents confusion with this file's source map
  return `//# ${"sourceMappingURL"}=data:application/json;base64,${encodedMap}\n`;
}

// Returns a string of a JS `sourceURL` comment with provided filename.
function sourceUrl(filename: string): string {
  // ${"sourceURL"} prevents confusion with this file's source map
  return `//# ${"sourceURL"}=${filename}\n`;
}

// `window.btoa` only works on characters that are contained in a single
// byte. This may not be the case for source code, so handle character
// out of range exceptions with this conversion.
function btoaFix(input: string): string {
  return btoa(
    Array.from(encode(input), (byte) => String.fromCodePoint(byte)).join(""),
  );
}
