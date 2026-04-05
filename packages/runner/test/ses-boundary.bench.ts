import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { preflightCompiledBundle } from "../src/sandbox/bundle-preflight.ts";
import { createCallbackCompartmentGlobals } from "../src/sandbox/compartment-globals.ts";
import { hardenVerifiedFunction } from "../src/sandbox/function-hardening.ts";
import {
  verifyCompiledBundleModuleFactoriesWithParser
    as verifyCompiledBundleModuleFactories,
} from "../src/sandbox/compiled-bundle-verifier.ts";
import { evaluateCallbackSourceInSES } from "../src/sandbox/mod.ts";
import { evaluateFunctionSourceInSES } from "../src/sandbox/ses-runtime.ts";

const signer = await Identity.fromPassphrase("bench ses boundary");

const benchProgram: RuntimeProgram = {
  main: "/main.ts",
  files: [
    {
      name: "/labels.ts",
      contents: [
        "const defaultLabel = 'Open';",
        "export default defaultLabel;",
      ].join("\n"),
    },
    {
      name: "/main.ts",
      contents: [
        'import { pattern } from "commontools";',
        "import defaultLabel from './labels.ts';",
        "export default pattern(() => ({",
        "  label: defaultLabel,",
        "}));",
      ].join("\n"),
    },
  ],
};

const callbackSource = "(value) => value + 1";

function createBenchEngine() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const engine = runtime.harness as Engine;
  return { engine, runtime, storageManager };
}

const compiledBundle = await (async () => {
  const { engine, runtime, storageManager } = createBenchEngine();
  try {
    return await engine.compile(benchProgram);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
})();

Deno.bench(
  "SES bundle verification: parser preflight + factory verifier",
  { group: "ses-verification" },
  () => {
    const filename = compiledBundle.jsScript.filename ?? "bench.js";
    preflightCompiledBundle(compiledBundle.jsScript.js, filename);
    verifyCompiledBundleModuleFactories(compiledBundle.jsScript.js, filename);
  },
);

Deno.bench(
  "SES Engine.evaluate: memoized bundle hash on repeated evaluates",
  { group: "ses-verification" },
  async (b) => {
    const { engine, runtime, storageManager } = createBenchEngine();
    try {
      await engine.evaluate(
        compiledBundle.id,
        compiledBundle.jsScript,
        benchProgram.files,
      );

      b.start();
      for (let i = 0; i < 25; i++) {
        await engine.evaluate(
          compiledBundle.id,
          compiledBundle.jsScript,
          benchProgram.files,
        );
      }
      b.end();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  },
);

const sharedCallback = evaluateCallbackSourceInSES(callbackSource) as (
  value: number,
) => number;

Deno.bench(
  "SES callback invocation: shared creator cache",
  { group: "ses-callback" },
  (b) => {
    b.start();
    for (let i = 0; i < 250; i++) {
      sharedCallback(i);
    }
    b.end();
  },
);

Deno.bench(
  "SES callback invocation: fresh compartment per call baseline",
  { group: "ses-callback" },
  (b) => {
    b.start();
    for (let i = 0; i < 250; i++) {
      const fn = evaluateFunctionSourceInSES(callbackSource, {
        globals: createCallbackCompartmentGlobals(),
        lockdown: true,
      });
      hardenVerifiedFunction(fn as (value: number) => number)(i);
    }
    b.end();
  },
);
