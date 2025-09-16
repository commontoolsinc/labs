/**
 * quickjs-emscripten bundles 4 runtimes ([release|debug] x [sync|async])
 * in its package. Use a specific release and expose a similar interface
 * from this quick.ts wrapper.
 */
import {
  newQuickJSWASMModuleFromVariant,
  QuickJSWASMModule,
} from "quickjs-emscripten-core";

export * from "quickjs-emscripten-core";

export async function getQuickJS(): Promise<QuickJSWASMModule> {
  return await newQuickJSWASMModuleFromVariant(
    // Use `singlefile` version in lieu of needing to handle
    // the wasm artifact separately across various build types
    import("@jitl/quickjs-singlefile-mjs-debug-sync"),
  );
}
