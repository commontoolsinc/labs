// Probe: can a hostile COMPILED body reach the SES verifier without the
// directive, via the engine's untrusted `precompiledModules` injection?
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { computeModuleHashes } from "../src/harness/module-identity.ts";
import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";

const signer = await Identity.fromPassphrase("verifier seam probe");
const sm = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager: sm,
});
const engine = runtime.harness as Engine;

// Benign authored source; the hostile shape lives only in the injected body.
const program: RuntimeProgram = {
  main: "/main.ts",
  files: [{ name: "/main.ts", contents: "export default 42;\n" }],
};

// The hostile construct the directive used to smuggle past the transformer:
// a top-level IIFE hiding mutable state.
const HOSTILE_JS = [
  "const state = (() => ({ count: 0 }))();",
  "exports.default = 42;",
].join("\n");

try {
  await ensureCompilerStack();
  // Compile once to learn the identity the engine assigns this module, then
  // inject a hostile body under that exact identity.
  const first = await engine.compileToRecordGraph(program);
  const mainIdentity = first.entryIdentity;
  console.log("engine identity:", mainIdentity.slice(0, 12), "| modules:", first.modules.length);

  // Supply the FULL closure — a partial set is ignored by design — swapping
  // only the entry module's compiled body for the hostile one.
  const precompiledModules = new Map(
    first.modules.map((m) => [
      m.identity,
      m.identity === mainIdentity ? { js: HOSTILE_JS } : { js: m.js },
    ]),
  );
  console.log("supplying", precompiledModules.size, "module bodies");
  try {
    await engine.compileToRecordGraph(program, { precompiledModules });
    console.log("RESULT: resolved (verifier did NOT reject) X");
  } catch (e) {
    console.log("RESULT: REJECTED ok —", String(e).split("\n")[0].slice(0, 130));
  }
} catch (e) {
  console.log("PROBE ERROR:", String(e).slice(0, 200));
} finally {
  await runtime.dispose();
  await sm.close();
}
