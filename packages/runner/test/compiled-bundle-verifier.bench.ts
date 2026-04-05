import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { parseCompiledBundleSource } from "../src/sandbox/compiled-js-parser.ts";
import { verifyParsedCompiledBundleModuleFactoriesWithParser } from "../src/sandbox/compiled-bundle-verifier.ts";

const signer = await Identity.fromPassphrase("bench compiled bundle verifier");

const smallBenchProgram: RuntimeProgram = {
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

function createBenchEngine() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const engine = runtime.harness as Engine;
  return { engine, runtime, storageManager };
}

async function compileProgram(program: RuntimeProgram) {
  const { engine, runtime, storageManager } = createBenchEngine();
  try {
    return await engine.compile(program);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

async function loadParkingCoordinatorProgram(): Promise<RuntimeProgram> {
  const contents = await Deno.readTextFile(
    new URL(
      "../../patterns/factory-outputs/parking-coordinator/main.tsx",
      import.meta.url,
    ),
  );
  return {
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents }],
  };
}

const [smallCompiledBundle, parkingCoordinatorCompiledBundle] = await Promise
  .all([
    compileProgram(smallBenchProgram),
    loadParkingCoordinatorProgram().then(compileProgram),
  ]);

const smallParsedBundle = parseCompiledBundleSource(
  smallCompiledBundle.jsScript.js,
);
const parkingCoordinatorParsedBundle = parseCompiledBundleSource(
  parkingCoordinatorCompiledBundle.jsScript.js,
);

Deno.bench(
  `verifyParsedCompiledBundleModuleFactoriesWithParser: small compiled bundle (${smallCompiledBundle.jsScript.js.length} chars)`,
  { group: "compiled-bundle-verifier" },
  () => {
    verifyParsedCompiledBundleModuleFactoriesWithParser(
      smallCompiledBundle.jsScript.js,
      smallParsedBundle,
    );
  },
);

Deno.bench(
  `verifyParsedCompiledBundleModuleFactoriesWithParser: parking-coordinator compiled bundle (${parkingCoordinatorCompiledBundle.jsScript.js.length} chars)`,
  { group: "compiled-bundle-verifier" },
  () => {
    verifyParsedCompiledBundleModuleFactoriesWithParser(
      parkingCoordinatorCompiledBundle.jsScript.js,
      parkingCoordinatorParsedBundle,
    );
  },
);
