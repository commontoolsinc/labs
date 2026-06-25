import { expect } from "@std/expect";
import "@commonfabric/utils/equal-ignoring-symbols";
import { waitFor } from "@commonfabric/integration";
import { fromFileUrl } from "@std/path";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../../runner/src/storage/cache.deno.ts";
import { Runtime } from "@commonfabric/runner";
import { sleep } from "@commonfabric/utils/sleep";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

// ---------------------------------------------------------------------------
// RI_FOOTPRINT_DUMP: per-scenario scheduler-node + document footprint census.
//
// Measurement-only, fully gated on `RI_FOOTPRINT_DUMP` — a complete no-op
// without the env var, exactly like the `RI_CENSUS_DUMP` block below. It exists
// to answer the Reactive Interpreter's original motivation on the
// generated-patterns suite: does coalescing REDUCE footprint (scheduler nodes +
// documents) on the simple handler-bearing patterns it engages?
//
//   - nodes: `runtime.scheduler.getGraphSnapshot().nodes.length` after the
//            scenario runs (same source the interpreter benches use), bucketed
//            by node `type`.
//   - docs:  distinct doc ids written/created by the workload, counted via a
//            commit tap on the emulated memory server — the in-process analog of
//            `makeDocCounter` in `default-app-interpreter-bench.ts`. We patch
//            `Server.prototype.connect` ONCE (gated) to wrap each connection's
//            `receive`, parse the inbound commit with the server's own
//            `parseClientMessage`, and tally distinct ids (`set` op == doc
//            create, matching the bench's create/written semantics).
//
// Cross-referenced with the interpreter census (`interpreted_ok` +
// `fallback_by_reason`) so footprint deltas can be split into engaged vs
// fallback scenarios. Both arms (flag OFF / flag ON) are run by invoking the
// suite twice; the aggregation lives in the analysis, not here.
// ---------------------------------------------------------------------------

const RI_FOOTPRINT_DUMP = Boolean(Deno.env.get("RI_FOOTPRINT_DUMP"));

interface FootprintDocCounter {
  writtenIds: Set<string>;
  createdIds: Set<string>;
}

/** The counter the active scenario's commits feed into (gated install only). */
let activeFootprintDocCounter: FootprintDocCounter | undefined;

let footprintConnectPatched = false;

/**
 * Install (once) a commit tap on the emulated memory server. Wraps
 * `Server.prototype.connect` so every connection's `receive` is intercepted;
 * each inbound commit's operations are tallied into the currently-active
 * scenario counter. Restoration is unnecessary — the patch is a transparent
 * pass-through whenever `activeFootprintDocCounter` is unset, and the whole
 * thing is gated behind `RI_FOOTPRINT_DUMP`.
 */
function ensureFootprintCommitTap(): void {
  if (footprintConnectPatched) return;
  footprintConnectPatched = true;

  const proto = MemoryV2Server.Server.prototype as unknown as {
    connect: (send: unknown) => { receive: (payload: string) => unknown };
  };
  const originalConnect = proto.connect;
  proto.connect = function (this: unknown, send: unknown) {
    const connection = originalConnect.call(this, send);
    const originalReceive = connection.receive.bind(connection);
    connection.receive = (payload: string) => {
      const counter = activeFootprintDocCounter;
      if (counter) {
        try {
          const parsed = MemoryV2Server.parseClientMessage(payload) as
            | { commit?: { operations?: Array<Record<string, unknown>> } }
            | null;
          const operations = parsed?.commit?.operations;
          if (Array.isArray(operations)) {
            for (const op of operations) {
              const id = typeof op.id === "string" ? op.id : undefined;
              if (!id) continue;
              counter.writtenIds.add(id);
              if (op.op === "set") counter.createdIds.add(id);
            }
          }
        } catch {
          // Measurement only; never let the tap perturb the server.
        }
      }
      return originalReceive(payload);
    };
    return connection;
  };
}

export interface EventSpec {
  stream: string;
  payload: unknown;
}

export interface AssertionSpec {
  path: string;
  value: unknown;
}

export interface TestStep {
  events?: EventSpec[];
  expect: AssertionSpec[];
}

export interface PatternIntegrationScenario<TArgument = any> {
  name: string;
  module: string | URL;
  exportName?: string;
  argument?: TArgument;
  steps: TestStep[];
}

const signer = await Identity.fromPassphrase("pattern integration harness");
const space = signer.did();

function splitPath(path: string): (string | number)[] {
  return path.split(".")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const index = Number(segment);
      return Number.isInteger(index) && index.toString() === segment
        ? index
        : segment;
    });
}

function resolveModulePath(moduleRef: string | URL): string {
  if (moduleRef instanceof URL) {
    if (moduleRef.protocol === "file:") {
      return fromFileUrl(moduleRef);
    }
    throw new Error(`Unsupported module URL protocol: ${moduleRef.protocol}`);
  }

  if (moduleRef.startsWith("file:")) {
    return fromFileUrl(new URL(moduleRef));
  }

  return moduleRef;
}

export async function runPatternScenario(scenario: PatternIntegrationScenario) {
  // Footprint census (RI_FOOTPRINT_DUMP): install the commit tap and bind a
  // fresh per-scenario doc counter before any storage activity. No-op otherwise.
  let footprintDocCounter: FootprintDocCounter | undefined;
  if (RI_FOOTPRINT_DUMP) {
    ensureFootprintCommitTap();
    footprintDocCounter = {
      writtenIds: new Set<string>(),
      createdIds: new Set<string>(),
    };
    activeFootprintDocCounter = footprintDocCounter;
  }

  const storageManager = StorageManager.emulate({ as: signer });
  const runtimeErrors: Error[] = [];
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    errorHandlers: [(error) => {
      runtimeErrors.push(error);
    }],
  });

  const modulePath = resolveModulePath(scenario.module);
  const programResolver = new FileSystemProgramResolver(modulePath);
  const program = await runtime.harness.resolve(programResolver);
  if (scenario.exportName) {
    program.mainExport = scenario.exportName;
  }
  const patternFactory = await runtime.patternManager.compilePattern(program);

  // Trust the harness-compiled pattern as host-provided code, exactly as a
  // production host (shell / system code that compiles a pattern in-process)
  // does via `runtime.unsafeTrustPattern`. This walks the built pattern's node
  // module implementations and admits each into THIS runtime's harness
  // verified-implementation index (with a content-addressed entry ref), so the
  // reactive interpreter's live-leaf trust gate
  // (`getVerifiedProvenance(impl)` OR a harness-resolvable entry ref) resolves
  // them as trusted leaves — the same gate production patterns satisfy through
  // their verified module-eval provenance.
  //
  // Authored leaves (handlers / lifts / computeds defined in the pattern
  // source) already carry verified provenance from `compilePattern`'s
  // `evaluateRecordGraph` → `recordModuleProvenance`, so this is a no-op for
  // them (first-write-wins). The functions it newly trusts are the framework
  // BUILTIN helper bodies that `recordModuleProvenance` never sees because they
  // are unexported runtime-module closures created at builder-run time (e.g.
  // the `str` interpolation lift defined inside `built-in.ts`). Those are
  // trusted-by-construction framework code, not user closures.
  //
  // FAITHFUL / SECURITY: this is the EXISTING production host-trust path, NOT a
  // change to the product trust gate and NOT an env override. Host trust is an
  // EXECUTION grant only — it records NO CFC provenance, so policy-facing
  // identity resolution still fails closed. It is scoped to THIS harness
  // Runtime's executable registry, so a genuinely untrusted live leaf (one not
  // reachable from a pattern the harness explicitly compiled and trusted) is
  // still rejected by the gate and falls back to the legacy SES path.
  runtime.unsafeTrustPattern(patternFactory, {
    reason: "generated-patterns integration harness: host-compiled pattern",
  });

  const tx = runtime.edit();
  const resultCell = runtime.getCell<any>(
    space,
    { scenario: scenario.name },
    patternFactory.resultSchema,
    tx,
  );
  const argument = scenario.argument ?? {};
  const result = runtime.run(tx, patternFactory, argument, resultCell);
  runtime.prepareTxForCommit(tx);
  const commitResult = await tx.commit();
  if (commitResult.error) {
    throw commitResult.error;
  }

  // Sink to keep the result reactive, track cancel function for cleanup
  const cancelSink = result.sink(() => {});
  await runtime.idle();

  let stepIndex = 0;
  const name = scenario.exportName ?? scenario.name;

  for (const step of scenario.steps) {
    stepIndex++;
    if (step.events) {
      for (const event of step.events) {
        const pathSegments = splitPath(event.stream);
        const targetCell = pathSegments.reduce(
          (cell, segment) => cell.key(segment),
          result,
        );
        await targetCell.pull();
        await runtime.editWithRetry((tx) =>
          targetCell.withTx(tx).send(event.payload)
        );
      }
      await runtime.idle();
    }

    for (const assertion of step.expect) {
      const pathSegments = splitPath(assertion.path);
      const targetCell = pathSegments.reduce(
        (cell, segment) => cell.key(segment),
        result,
      );

      // Use waitFor to poll until assertion passes or timeout
      let actual: unknown;
      try {
        await waitFor(async () => {
          actual = await targetCell.pull();
          try {
            expect(actual).toEqualIgnoringSymbols(assertion.value);
            return true;
          } catch {
            return false;
          }
        }, { timeout: 5000, delay: 50 });
      } catch {
        // Pull final value for detailed assertion error on timeout
        actual = await targetCell.pull();
      }

      // Final assertion with expect() to get proper error messages on failure
      expect(actual, `${name}:${stepIndex}:${assertion.path}`)
        .toEqualIgnoringSymbols(assertion.value);
    }
  }

  // Cancel the sink to stop reactive updates
  cancelSink();

  // Wait for any pending work to complete before cleanup
  await runtime.idle();

  // Small delay to allow any pending debounce timers to either fire or be cancelled
  await sleep(100);

  if (Deno.env.get("RI_CENSUS_DUMP")) {
    console.error(
      "RI_CENSUS",
      name,
      JSON.stringify(runtime.runner.getInterpreterCensus()),
    );
  }

  if (RI_FOOTPRINT_DUMP && footprintDocCounter) {
    const graph = runtime.scheduler.getGraphSnapshot();
    const byType: Record<string, number> = {};
    for (const node of graph.nodes) {
      const type = (node as { type?: string }).type ?? "?";
      byType[type] = (byType[type] ?? 0) + 1;
    }
    const census = runtime.runner.getInterpreterCensus();
    const totalFallback = Object.values(census.fallback_by_reason)
      .reduce((sum, n) => sum + n, 0);
    console.error(
      "RI_FOOTPRINT",
      JSON.stringify({
        scenario: name,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        byType,
        docsCreated: footprintDocCounter.createdIds.size,
        docsWritten: footprintDocCounter.writtenIds.size,
        interpreted_ok: census.interpreted_ok,
        fallback_total: totalFallback,
        fallback_by_reason: census.fallback_by_reason,
      }),
    );
    activeFootprintDocCounter = undefined;
  }

  await runtime.dispose();
  await storageManager.close();

  if (runtimeErrors.length > 0) {
    const errorMessages = runtimeErrors.map((e) => e.message).join("\n");
    throw new Error(
      `Test passed but runtime errors occurred:\n${errorMessages}`,
    );
  }
}
