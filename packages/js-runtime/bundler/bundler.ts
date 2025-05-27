import { ExecutableJs, JsArtifact } from "../interface.ts";
import { JsSourceConcat } from "./js-source-concat.ts";
import { resolvePath } from "./normalize-path.ts";

// Template string providing implementations mapping a `require`
// function to an `export`.
const BOILERPLATE_START = `
((runtimeDependencies) => {
const [__GET_EXPORTS, __INIT_MODULE] = (() => {
  const modules = Object.create(null);

  ${resolvePath.toString()}
 
  function require(requesterFilename, path) {
    const resolved = resolvePath(requesterFilename, path);
    const exports = __GET_EXPORTS(resolved);
    if (exports) {
      return exports;
    } else if (runtimeDependencies) {
      if (runtimeDependencies[path]) {
        return runtimeDependencies[path];
      } 
    }
    throw new Error("Could not resolve " + path + " from " + requesterFilename);
  }

  function __GET_EXPORTS(filename) {
    return modules[filename];
  }

  function __INIT_MODULE(filename, callback) {
    if (modules[filename]) {
       throw new Error("Duplicate modules with name: " + filename);
    }
    modules[filename] = callback(require.bind(null, filename)); 
  }
  return [__GET_EXPORTS, __INIT_MODULE];
})();`;

export interface BundleConfig {
  // A set of JS modules.
  source: JsArtifact;
  // An additional string to inject into the bundle.
  injectedScript?: string;
  // The filename to use in source maps.
  filename?: string;
  // By default, the bundle evaluates to the `exports`
  // of the entry module.
  // If `runtimeDependencies` is true, the bundle instead
  // evaluates to a function that takes a single argument
  // containing runtime dependencies, mapping bare specifier name
  // to the dependency's `exports`.
  runtimeDependencies?: boolean;
}

// Bundles a set of JS modules together into
// a single JS file.
export const bundle = ({
  source,
  injectedScript,
  filename,
  runtimeDependencies,
}: BundleConfig): ExecutableJs => {
  const builder = new JsSourceConcat("OUTNAME-WHERE-IS-THIS-USED");

  builder.push(BOILERPLATE_START);
  if (injectedScript) {
    builder.push(injectedScript);
  }

  for (const filename of Object.keys(source.modules)) {
    const module = source.modules[filename];
    builder.push(
      `\n__INIT_MODULE("${module.originalFilename}", (require) => { const exports = Object.create(null);\n`,
    );
    builder.pushMapped(module);
    builder.push(`\nreturn exports; });\n`);
  }

  const maybeInvoke = runtimeDependencies === true ? "" : "()";
  builder.push(`\nreturn __GET_EXPORTS("${source.entry}");})${maybeInvoke}`);

  const out = builder.render({
    filename,
    inlineSourceMaps: true,
  }) as ExecutableJs;
  if (filename) {
    out.filename = filename;
  }
  return out;
};
