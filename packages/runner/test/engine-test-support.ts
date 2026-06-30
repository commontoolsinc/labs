import { Identity } from "@commonfabric/identity";
import type { CompiledModuleGraph } from "../src/sandbox/module-record-compiler.ts";

export {
  FileSystemProgramResolver,
  InMemoryProgram,
} from "@commonfabric/js-compiler";
export { getVerifiedProvenance } from "../src/harness/verified-provenance.ts";
export { StorageManager } from "../src/storage/cache.deno.ts";
export { Runtime } from "../src/runtime.ts";
export { Engine } from "../src/harness/engine.ts";
export type { RuntimeProgram } from "../src/harness/types.ts";

export const signer = await Identity.fromPassphrase("test operator");

// All authored modules' compiled CommonJS bodies, joined — the ESM analogue of
// the old single-bundle `jsScript.js` for transformer-output assertions.
export const joinedBodies = (graph: CompiledModuleGraph): string =>
  [...graph.compiledBodies.values()].join("\n");
