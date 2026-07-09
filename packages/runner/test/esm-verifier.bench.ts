/**
 * ESM verifier body-vs-graph split benchmark (CT-1623).
 *
 * Isolates the per-module body scan (`verifyCompiledModuleBody` summed over all
 * authored bodies) from the whole-graph structural check (`verifyModuleGraph`),
 * for a small synthetic program and the real parking-coordinator pattern.
 *
 * Pre-compile everything OUTSIDE the timed regions so the bench measures only
 * the security-verify step, not the TypeScript compile.
 *
 * Run:
 *   deno bench --allow-read --allow-write --allow-net --allow-ffi --allow-env \
 *     --no-check packages/runner/test/esm-verifier.bench.ts
 */
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import {
  verifyCompiledModuleBody,
  verifyModuleGraph,
} from "../src/sandbox/module-record-verifier.ts";
import {
  type BindingInfo,
  classifyModuleItems,
} from "../src/sandbox/compiled-bundle-verifier.ts";
import { parseFunctionText } from "../src/sandbox/compiled-js-parser.ts";
import {
  isAllowedAuthoredImportSpecifier,
  isRuntimeModuleIdentifier,
} from "../src/sandbox/runtime-module-policy.ts";
import {
  isAllowedTsLibHelperDeclaration,
  normalizeExact,
} from "../src/sandbox/tslib-helpers.ts";

// ---------------------------------------------------------------------------
// Pre-shadow-detection baseline: the single-pass verifyCompiledModuleBody from
// Phase D2.1 (commit 4e3f69d05), before the helper-shadow bypass fix landed in
// 3517a3433 / a0213d532 added a second full statement scan.
// This is used ONLY in the regression-delta bench group to quantify the cost of
// the shadow-detection pass. Product code is untouched.
// ---------------------------------------------------------------------------

const EMPTY_BINDING_SET: ReadonlySet<string> = new Set<string>();

const REQUIRE_IMPORT_LEGACY = new RegExp(
  "^const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*" +
    "(?:__importDefault|__importStar)?\\s*\\(?\\s*" +
    "require\\(\\s*[\"']([^\"']+)[\"']\\s*\\)\\s*\\)?\\s*;?$",
);

/**
 * Single-pass body verifier (pre-shadow-detection, Phase D2.1).
 * Omits the shadow-name scan over all statements; used only to measure
 * the overhead that the shadow-detection pass adds.
 */
function verifyCompiledModuleBodyLegacy(
  compiled: string,
  filename = "<module>",
): void {
  const wrapped = `function () {\n${compiled}\n}`;
  const parsed = parseFunctionText(wrapped, 0, wrapped.length);

  const env = new Map<string, BindingInfo>();
  const classifiable: typeof parsed.body.statements = [];
  for (const statement of parsed.body.statements) {
    const text = wrapped.slice(statement.start, statement.end).trim();
    // Inline tslib helper declarations: skip (not present in Phase D2.1 but
    // cheap to add here so the diff is strictly the shadow-scan cost).
    if (isAllowedTsLibHelperDeclaration(normalizeExact(text))) continue;
    const match = REQUIRE_IMPORT_LEGACY.exec(text);
    if (match && isAllowedAuthoredImportSpecifier(match[2])) {
      const [, binding, specifier] = match;
      env.set(binding, {
        kind: "import",
        dependencySpecifier: specifier,
        namespaceImport: true,
        trustedRuntimeName: isRuntimeModuleIdentifier(specifier)
          ? specifier
          : undefined,
      });
      continue;
    }
    classifiable.push(statement);
  }

  classifyModuleItems(wrapped, filename, classifiable, env, {
    requiredGuards: EMPTY_BINDING_SET,
    reservedBindings: EMPTY_BINDING_SET,
    missingGuardsErrorAt: 0,
  });
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

const signer = await Identity.fromPassphrase("bench esm verifier");

function createBenchEngine() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const engine = runtime.harness as Engine;
  return { engine, runtime, storageManager };
}

async function compileToGraph(program: RuntimeProgram) {
  const { engine, runtime, storageManager } = createBenchEngine();
  try {
    // compileToRecordGraph runs the full pipeline (TS → records → verify).
    // We keep the result for the pre-parsed bodies + record map. The verify
    // step running here does NOT affect the bench timings below — those each
    // call the verifier functions afresh on the pre-built inputs.
    return await engine.compileToRecordGraph(program);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

/** Small: 2 authored modules, minimal bodies. */
const smallProgram: RuntimeProgram = {
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
        'import { pattern } from "commonfabric";',
        "import defaultLabel from './labels.ts';",
        "export default pattern(() => ({",
        "  label: defaultLabel,",
        "}));",
      ].join("\n"),
    },
  ],
};

async function loadParkingCoordinatorProgram(): Promise<RuntimeProgram> {
  const [contents, adminContents, vehiclesContents] = await Promise.all([
    Deno.readTextFile(
      new URL(
        "../../patterns/factory-outputs/parking-coordinator/main.tsx",
        import.meta.url,
      ),
    ),
    Deno.readTextFile(
      new URL("../../patterns/cfc/admin/mod.ts", import.meta.url),
    ),
    Deno.readTextFile(new URL("../../patterns/vehicles.ts", import.meta.url)),
  ]);
  return {
    main: "/factory-outputs/parking-coordinator/main.tsx",
    files: [
      { name: "/factory-outputs/parking-coordinator/main.tsx", contents },
      { name: "/cfc/admin/mod.ts", contents: adminContents },
      { name: "/vehicles.ts", contents: vehiclesContents },
    ],
  };
}

// ---------------------------------------------------------------------------
// Pre-compile everything (outside bench timing)
// ---------------------------------------------------------------------------

const parkingCoordinatorProgram = await loadParkingCoordinatorProgram();

const [
  smallGraph,
  parkingGraph,
] = await Promise.all([
  compileToGraph(smallProgram),
  compileToGraph(parkingCoordinatorProgram),
]);

// Snapshot compiled bodies as plain arrays so the bench loop is allocation-free
const smallBodies = [...smallGraph.graph.compiledBodies.entries()];
const parkingBodies = [...parkingGraph.graph.compiledBodies.entries()];

// Snapshot record maps + main specifiers for graph verify
const smallRecords = smallGraph.graph.records;
const smallMainSpec = smallGraph.mainSpecifier;
const parkingRecords = parkingGraph.graph.records;
const parkingMainSpec = parkingGraph.mainSpecifier;

// Log program sizes for reference
console.error(
  `small: ${smallBodies.length} authored bodies, ` +
    `total body bytes: ${smallBodies.reduce((s, [, b]) => s + b.length, 0)}`,
);
console.error(
  `parking-coordinator: ${parkingBodies.length} authored bodies, ` +
    `total body bytes: ${parkingBodies.reduce((s, [, b]) => s + b.length, 0)}`,
);

// ---------------------------------------------------------------------------
// Benchmarks: small program
// ---------------------------------------------------------------------------

Deno.bench(
  `ESM body verify (all bodies summed): small [${smallBodies.length} modules]`,
  { group: "esm-verifier-small", baseline: true },
  () => {
    for (const [specifier, body] of smallBodies) {
      verifyCompiledModuleBody(body, specifier);
    }
  },
);

Deno.bench(
  `ESM graph verify: small [${smallRecords.size} records]`,
  { group: "esm-verifier-small" },
  () => {
    verifyModuleGraph(smallRecords, smallMainSpec);
  },
);

// ---------------------------------------------------------------------------
// Benchmarks: parking-coordinator (large)
// ---------------------------------------------------------------------------

Deno.bench(
  `ESM body verify (all bodies summed): parking-coordinator [${parkingBodies.length} modules]`,
  { group: "esm-verifier-parking", baseline: true },
  () => {
    for (const [specifier, body] of parkingBodies) {
      verifyCompiledModuleBody(body, specifier);
    }
  },
);

Deno.bench(
  `ESM graph verify: parking-coordinator [${parkingRecords.size} records]`,
  { group: "esm-verifier-parking" },
  () => {
    verifyModuleGraph(parkingRecords, parkingMainSpec);
  },
);

// ---------------------------------------------------------------------------
// Per-module body verify: one bench per authored module (parking only, to
// show per-module cost distribution — body size varies widely in a real
// pattern, the per-module numbers help pinpoint which module dominates).
// ---------------------------------------------------------------------------

for (const [specifier, body] of parkingBodies) {
  // Trim specifier to a readable label (last 12 hex chars of the hash)
  const label = specifier.replace("cf:module/", "").slice(-12);
  Deno.bench(
    `ESM body verify: module …${label} [${body.length} bytes]`,
    { group: "esm-verifier-per-module" },
    () => {
      verifyCompiledModuleBody(body, specifier);
    },
  );
}

// ---------------------------------------------------------------------------
// Regression delta: shadow-detection pass overhead
//
// Compare current `verifyCompiledModuleBody` (two passes: shadow-scan + classify)
// against the pre-shadow-detection single-pass version from Phase D2.1.
// The delta is the overhead introduced by commits 3517a3433 + a0213d532.
// ---------------------------------------------------------------------------

// Use only the dominant large module (first parking body by size) for the
// per-module regression delta, so the signal is not diluted by tiny modules.
const [dominantSpec, dominantBody] = parkingBodies.reduce((max, cur) =>
  cur[1].length > max[1].length ? cur : max
);

Deno.bench(
  `ESM body verify (current, two-pass): dominant module [${dominantBody.length} bytes]`,
  { group: "esm-verifier-regression-delta", baseline: true },
  () => {
    verifyCompiledModuleBody(dominantBody, dominantSpec);
  },
);

Deno.bench(
  `ESM body verify (legacy single-pass, pre-shadow-detection): dominant module [${dominantBody.length} bytes]`,
  { group: "esm-verifier-regression-delta" },
  () => {
    verifyCompiledModuleBodyLegacy(dominantBody, dominantSpec);
  },
);

// Also run the regression delta over all parking bodies summed
Deno.bench(
  `ESM body verify (current, two-pass): parking all bodies [${parkingBodies.length} modules]`,
  { group: "esm-verifier-regression-all", baseline: true },
  () => {
    for (const [specifier, body] of parkingBodies) {
      verifyCompiledModuleBody(body, specifier);
    }
  },
);

Deno.bench(
  `ESM body verify (legacy single-pass): parking all bodies [${parkingBodies.length} modules]`,
  { group: "esm-verifier-regression-all" },
  () => {
    for (const [specifier, body] of parkingBodies) {
      verifyCompiledModuleBodyLegacy(body, specifier);
    }
  },
);
