/**
 * THE GATE PROBE THAT CONTAINS A PATTERN EFFECT — terminal-condition item 4.
 *
 * The corrected serving gate (`candidateUnservedByCode` + `actionFirewall-
 * Rejects` + `commit-rejected:*`) measures COMPUTATION ADMISSION; the
 * categorical client-egress flip acts on EFFECT DISPATCH. They were measured
 * DISJOINT — a throwaway flip trial did not move the gate by a single digit —
 * because every gate probe in this directory contains no pattern effect at
 * all. So "refusals → 0" says nothing about egress, and nothing here could see
 * an egress move.
 *
 * The webhook topology IS that missing probe, and it is the only shape in the
 * repo where a SERVER process that is not the executor runs a user's pattern:
 *
 *   a webhook delivery is a plain stream write, and a plain stream write is a
 *   pattern-execution entry point. The scheduler finds no local handler, calls
 *   `ensurePieceRunning`, loads the pattern and starts the piece inside the
 *   API-server process, and runs its whole reactive graph — effect builtins
 *   included. `ensure-piece-running.ts` is a client-authority execution entry
 *   point reachable from a plain stream write; that generalises past toolshed.
 *
 * WHAT THIS FIXTURE ASSERTS, and why "exactly one" is the whole point.
 * Toolshed declares `externalSinkDisposition: "suppress"`
 * (`packages/toolshed/runtime-options.ts`), so the API-server process may not
 * egress. The side effect must therefore still happen, once, and on the
 * server-side executor:
 *
 *   - ZERO would mean the pin silently deleted a webhook side effect — the
 *     failure the arc calls strictly worse than duplication, and exactly the
 *     option-(c) trap (suppressing the local start would also suppress the
 *     demand publication at `runner.ts`'s `start()` → `addExecutionDemand`,
 *     so no executor would ever become live and nothing would run the hook).
 *   - TWO would mean double egress: both the API server and the executor
 *     performed the outside-world action.
 *
 * The broker is the executor's own network seam (`createBuiltinBroker` is
 * reachable only through the Worker's `serverBuiltinFetch`), and
 * `authorizeBuiltinRequest` carries the host-derived acting identity — so a
 * broker request is by construction an EXECUTOR egress, attributed to a lane.
 * The API server's egress is counted separately at its `runtime.fetch` seam,
 * which is where a released sink would land for a runtime with no broker.
 *
 * TOPOLOGY. A real memory-v2 Server over loopback with a file-backed store, a
 * real `SharedExecutionPool` driving a REAL Deno executor Worker, a seed
 * client that creates the piece and leaves, and ONE runtime built from the
 * REAL `toolshedRuntimeOptions` standing in for the API server. The pool does
 * NOT wake an executor that is already live, and `set-demand` only enqueues
 * the structural swap, so the Worker's `settle()`/`wake()`/`settle()` fixpoint
 * is driven explicitly — without it the Worker goes live, takes its lanes, and
 * runs nothing.
 */

import { assertEquals, assertExists } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { MemoryProtocolFlags } from "@commonfabric/memory/v2";
import { Server } from "@commonfabric/memory/v2/server";
import {
  SharedExecutionPool,
  type SpaceExecutor,
} from "@commonfabric/runner/executor";
import { DenoSpaceExecutorFactory } from "@commonfabric/runner/executor/deno";
import {
  EXPERIMENTAL_ENV_VARS,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
// The real production assembly, imported rather than reconstructed: a copy of
// toolshed's wiring here could drift from toolshed's own and the fixture would
// keep passing while production changed. `packages/toolshed` declares no
// package name, so the workspace-relative path is the only route.
import { toolshedRuntimeOptions } from "../../toolshed/runtime-options.ts";
import {
  LoopbackStorageManager,
  waitForCondition,
  withExecutorTeardownBarrier,
} from "./server-execution-session-lane-harness.ts";

const FLAGS = {
  persistentSchedulerState: true,
  schedulerWriterLookup: true,
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
} as const satisfies Partial<MemoryProtocolFlags>;

const DOWNSTREAM_URL = "https://webhook-downstream.invalid/notify";

/**
 * A webhook-shaped consumer: an inbox stream whose handler writes a url, and
 * an EFFECT builtin (`fetchText`, a `SERVER_EXECUTABLE_BUILTIN_IDS` member)
 * downstream of that write. `Default<''>` keeps the seed run egress-free
 * (`fetch.ts` returns early on an empty url), so every request either counter
 * sees is caused by the webhook delivery.
 */
const WEBHOOK_EGRESS_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "/// <cts-enable />",
      "import { Default, fetchText, handler, pattern, Writable } from 'commonfabric';",
      "",
      "const onWebhookEvent = handler<",
      "  { url: string },",
      "  { target: Writable<string> }",
      ">((event, { target }) => {",
      "  target.set(event.url);",
      "});",
      "",
      "export default pattern<{",
      "  target: Writable<string | Default<''>>;",
      "}>(({ target }) => ({",
      "  target,",
      "  inbox: onWebhookEvent({ target }),",
      "  fetched: fetchText({ url: target }),",
      "}));",
    ].join("\n"),
  }],
};

/** Toolshed reads its experimental flags from the environment; server-primary
 * execution is what gates `addExecutionDemand` (and, in the deployment, the
 * pool itself), so a pool-running toolshed has it on. */
const toolshedEnv = (name: string): string | undefined =>
  name === EXPERIMENTAL_ENV_VARS.serverPrimaryExecution ||
    name === EXPERIMENTAL_ENV_VARS.persistentSchedulerState
    ? "true"
    : undefined;

Deno.test({
  name:
    "webhook egress gate: a suppressed toolshed runtime still starts the piece, and the EXECUTOR performs exactly one broker egress",
  async fn() {
    await withExecutorTeardownBarrier(async () => {
      const spaceIdentity = await Identity.generate({
        implementation: "noble",
      });
      const space = spaceIdentity.did() as MemorySpace;
      const storeDir = await Deno.makeTempDir({ prefix: "webhook-egress-" });
      const server = new Server({
        store: new URL(`file://${storeDir}/`),
        authorizeSessionOpen(message) {
          const value = (message.authorization as { principal?: unknown })
            ?.principal;
          return typeof value === "string" ? value : undefined;
        },
        sessionOpenAuth: { audience: "did:key:z6Mk-webhook-egress-gate" },
        protocolFlags: FLAGS,
        acl: { mode: "off", serviceDids: [space] },
      });

      /** Egress performed by the EXECUTOR Worker (its only network seam). */
      const brokerRequests: string[] = [];
      /** Host-derived acting identities behind those requests. */
      const actingLanes: string[] = [];
      /** Egress performed by the API-SERVER process (a released sink lands on
       * `runtime.fetch` for a runtime with no builtin broker). */
      const toolshedFetches: string[] = [];
      const events: string[] = [];

      const seedIdentity = await Identity.generate({ implementation: "noble" });
      const seedStorage = LoopbackStorageManager.connectTo(server, FLAGS, {
        as: seedIdentity,
      });
      const seedRuntime = new Runtime({
        apiUrl: new URL("https://toolshed.example/"),
        patternEnvironment: { apiUrl: new URL("https://toolshed.example/") },
        storageManager: seedStorage,
        fetch: () => Promise.reject(new Error("the seed must not egress")),
        externalSinkDisposition: "suppress",
        experimental: {
          persistentSchedulerState: true,
          serverPrimaryExecution: true,
        },
      });

      const toolshedIdentity = await Identity.generate({
        implementation: "noble",
      });
      const toolshedStorage = LoopbackStorageManager.connectTo(server, FLAGS, {
        as: toolshedIdentity,
      });
      const toolshedOptions = toolshedRuntimeOptions(
        {
          MEMORY_URL: "https://toolshed.example/",
          API_URL: "https://toolshed.example/",
        },
        toolshedStorage,
        toolshedEnv,
      );
      const toolshedRuntime = new Runtime({
        ...toolshedOptions,
        fetch: (input: RequestInfo | URL) => {
          toolshedFetches.push(
            typeof input === "string" ? input : input.toString(),
          );
          return Promise.resolve(new Response("served-by-the-api-server"));
        },
      });

      let pool: SharedExecutionPool | null = null;
      let liveExecutor: SpaceExecutor | undefined;
      try {
        // ── Seed: some client creates the piece and leaves. Toolshed never
        // ran it, exactly as a fresh API-server process finds it.
        const compiled = await seedRuntime.patternManager.compilePattern(
          WEBHOOK_EGRESS_PROGRAM,
          { space },
        );
        const tx = seedRuntime.edit();
        const result = seedRuntime.getCell<Record<string, unknown>>(
          space,
          "webhook-egress-gate-result",
          undefined,
          tx,
        );
        const handle = seedRuntime.run(tx, compiled, {}, result);
        seedRuntime.prepareTxForCommit(tx);
        assertEquals((await tx.commit()).error, undefined);
        await handle.pull();
        await seedRuntime.settled();
        await seedStorage.synced();
        const resultLink = result.getAsNormalizedFullLink();
        await seedRuntime.dispose();
        await seedStorage.close();

        // ── The pool and its real Deno Worker.
        const factory = new DenoSpaceExecutorFactory({
          server,
          apiUrl: new URL("https://toolshed.example/"),
          patternApiUrl: new URL("https://toolshed.example/"),
          experimental: {
            persistentSchedulerState: true,
            serverPrimaryExecution: true,
          },
          createBuiltinBroker: () => ({
            fetch(request) {
              brokerRequests.push(request.url);
              events.push(`broker:${request.url}`);
              return Promise.resolve({
                response: new Response("served-by-the-executor"),
                finalUrl: new URL(request.url),
                redirectCount: 0,
              });
            },
          }),
          authorizeBuiltinRequest: (request) => {
            actingLanes.push(request.actingIdentity.lane);
            events.push(`authorize:${request.actingIdentity.lane}`);
          },
          onCandidateClaim: (candidate) => {
            server.recordExecutionCandidateClaimReady(candidate.claimKey);
            events.push(`candidate:${candidate.claimKey.contextKey}`);
          },
          onCandidateDiagnostic: (diagnostic) => {
            server.recordExecutionCandidateUnserved(diagnostic);
            events.push(`diagnostic:${diagnostic.diagnosticCode}`);
          },
        });
        pool = new SharedExecutionPool({
          control: server,
          factory: {
            async start(options) {
              liveExecutor = await factory.start({
                ...options,
                onCrash(error) {
                  events.push(`crash:${String(error)}`);
                  options.onCrash(error);
                },
              });
              return liveExecutor;
            },
          },
          settleTimeoutMs: 20_000,
          legacyBackgroundActive: () => false,
        });
        pool.start();

        // ── THE DELIVERY. Resolve the inbox link, re-read it as a stream and
        // `send` inside `editWithRetry` — `sendToStream`'s exact shape. The
        // piece is not running in this process, so the commit's scheduler
        // event finds no local handler and `ensurePieceRunning` starts it;
        // that start is also what publishes the execution demand.
        const toolshedResult = toolshedRuntime.getCellFromLink(resultLink);
        const targetValue = (): unknown =>
          (toolshedResult.get() as { target?: unknown } | undefined)?.target;
        await toolshedResult.sync();
        await toolshedStorage.synced();
        const streamCell = toolshedRuntime
          .getCellFromLink(
            toolshedResult.key("inbox").getAsNormalizedFullLink(),
          )
          .asSchema({ asCell: ["stream"] });
        await streamCell.sync();
        await toolshedStorage.synced();
        const { error } = await toolshedRuntime.editWithRetry((etx) => {
          streamCell.withTx(etx).send({ url: DOWNSTREAM_URL });
        });
        assertEquals(error, undefined, "the webhook send failed");
        await toolshedRuntime.idle();
        await toolshedRuntime.settled();
        await toolshedStorage.synced();

        // THE OPTION-(c) GUARD: the local start must still have happened.
        // Without it there is no demand, no executor, and no side effect at
        // all — a suppression that silently deletes the webhook.
        await waitForCondition(
          "the webhook started the piece in the api-server process",
          () => targetValue() === DOWNSTREAM_URL,
          targetValue,
        );
        await waitForCondition(
          "toolshed published execution demand",
          () => server.listExecutionDemands(space, "").length > 0,
          () => server.listExecutionDemands(space, ""),
        );

        await pool.idle();
        await waitForCondition(
          "pool live",
          () => pool!.metrics().activeWorkers > 0,
          () => pool!.metrics(),
        );
        assertExists(
          liveExecutor,
          "the pool reported a live worker with no executor",
        );
        // Activation completion is observable ONLY through settle(); the pool
        // never drives a live Worker, so drive its fixpoint here.
        await liveExecutor.settle();
        await liveExecutor.wake();
        await liveExecutor.settle();

        await waitForCondition(
          "the executor performed the webhook's egress",
          () => brokerRequests.length > 0,
          () => ({ events: events.slice(-40), toolshedFetches }),
        );
        // Quiesce so a SECOND egress (double dispatch) would be counted rather
        // than raced past.
        await liveExecutor.wake();
        await liveExecutor.settle();
        await pool.idle();
        await toolshedRuntime.idle();
        await toolshedRuntime.settled();

        // REPORTED, NOT ASSERTED — the corrected gate's own arms, taken from
        // the same `server.executionStats` object `/api/health/stats` serves,
        // beside the egress counts. This is what makes the probe an
        // INSTRUMENT for the terminal condition rather than only a regression
        // pin: it is the first fixture in this directory whose workload
        // contains a pattern effect, so it is the first place the gate's
        // numbers and an egress count can be read off one run. Absolute counts
        // move with load and with the runtime, so pinning them would turn an
        // unrelated change into a failure of this file.
        const stats = server.executionStats as unknown as Record<
          string,
          unknown
        >;
        console.log(
          "webhook egress gate\n" +
            `  executorBrokerEgress=${JSON.stringify(brokerRequests)} ` +
            `actingLanes=${JSON.stringify(actingLanes)} ` +
            `apiServerEgress=${JSON.stringify(toolshedFetches)}\n` +
            `  candidateUnservedByCode=${
              JSON.stringify(stats.candidateUnservedByCode ?? {})
            }\n` +
            `  actionFirewallRejects=${
              JSON.stringify(stats.actionFirewallRejects ?? 0)
            } ` +
            `settlementsCommitted=${
              JSON.stringify(stats.settlementsCommitted ?? 0)
            } ` +
            `settlementsUnserved=${
              JSON.stringify(stats.settlementsUnserved ?? 0)
            }\n` +
            `  executorEvents=${JSON.stringify(events)}`,
        );

        assertEquals(
          events.filter((event) => event.startsWith("crash:")),
          [],
        );
        // ZERO would be the silent-deletion failure; TWO would be double
        // egress. The identity is host-derived from the claim, so this also
        // says WHO performed it.
        assertEquals(
          brokerRequests,
          [DOWNSTREAM_URL],
          `executor egress was not exactly one; events: ${
            JSON.stringify(events.slice(-40))
          }`,
        );
        assertEquals(actingLanes, ["space"]);
        assertEquals(
          toolshedFetches,
          [],
          "the api-server process performed the webhook's egress itself",
        );
        assertEquals(toolshedOptions.externalSinkDisposition, "suppress");
      } finally {
        await pool?.close().catch(() => undefined);
        await toolshedRuntime.dispose().catch(() => undefined);
        await toolshedStorage.close().catch(() => undefined);
        await seedRuntime.dispose().catch(() => undefined);
        await seedStorage.close().catch(() => undefined);
        await server.close().catch(() => undefined);
        await Deno.remove(storeDir, { recursive: true }).catch(() => undefined);
      }
    });
  },
});
