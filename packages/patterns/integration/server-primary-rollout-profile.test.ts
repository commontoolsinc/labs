import {
  CdpWorkerProfiler,
  type CPUProfile,
  env,
  type Page,
  summarizeCPUProfile,
  waitFor,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { Identity } from "@commonfabric/identity";
import { executionPolicyId } from "@commonfabric/memory/v2";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";
import {
  clickCfButton,
  collectBrowserLoadSummary,
  waitForRuntimeIdle,
  waitForText,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;
const SERVER_EXECUTION_ENABLED =
  Deno.env.get("EXPERIMENTAL_SERVER_PRIMARY_EXECUTION") === "true" ||
  Deno.env.get("EXPERIMENTAL_SERVER_PRIMARY_EXECUTION") === "1";
const CPU_BENCH = Deno.env.get("CF_SERVER_EXECUTION_CPU_BENCH") === "1";
const CPU_EVENTS = Math.max(
  2,
  Number(Deno.env.get("CF_SERVER_EXECUTION_CPU_EVENTS")) || 12,
);
const PROFILE_DIR = Deno.env.get("CF_CPUPROFILE_DIR");
const TIMEOUT = 60_000;

type ActionTraceEntry = {
  actionId: string;
  actualWrites: Array<{ entityId: string; path: string[] }>;
};

type ServerExecutionHealth = {
  serverExecutionPool: {
    activeWorkers: number;
    activeDemands: number;
  } | null;
  serverExecutionControl: Record<string, number> | null;
};

type PhaseResult = {
  label: string;
  policyEnabled: boolean;
  events: number;
  actionRuns: number[];
  clientDerivedSuppressed: number;
  clientDerivedUpstreamCommits: number;
  serverAcceptedActionAttempts: number;
  observedActionWrites: string[];
  cpu?: ReturnType<typeof summarizeCPUProfile>;
};

async function writePolicy(
  controller: PiecesController,
  enabled: boolean,
): Promise<void> {
  const runtime = controller.manager().runtime;
  const space = controller.manager().getSpace();
  const tx = runtime.edit();
  const write = tx.write({
    space,
    id: executionPolicyId(space),
    type: "application/json",
    path: [],
  }, {
    value: { version: 1, serverPrimaryExecution: enabled },
  });
  if (write.error) throw new Error(write.error.message);
  const committed = await tx.commit();
  if (committed.error) throw new Error(committed.error.message);
  await runtime.storageManager.synced();
}

async function executionHealth(): Promise<ServerExecutionHealth> {
  const response = await fetch(new URL("/api/health/stats", API_URL));
  if (!response.ok) {
    throw new Error(`health stats failed with ${response.status}`);
  }
  return await response.json() as ServerExecutionHealth;
}

const controlCount = (
  health: ServerExecutionHealth,
  key: string,
): number => health.serverExecutionControl?.[key] ?? 0;

async function resetActionTrace(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const rt = (globalThis as typeof globalThis & {
      commonfabric?: {
        rt?: { setActionRunTraceEnabled(enabled: boolean): Promise<void> };
      };
    }).commonfabric?.rt;
    if (!rt) throw new Error("runtime action trace is unavailable");
    await rt.setActionRunTraceEnabled(false);
    await rt.setActionRunTraceEnabled(true);
  });
}

async function actionTrace(page: Page): Promise<ActionTraceEntry[]> {
  return await page.evaluate(async () => {
    const rt = (globalThis as typeof globalThis & {
      commonfabric?: {
        rt?: { getActionRunTrace(): Promise<ActionTraceEntry[]> };
      };
    }).commonfabric?.rt;
    if (!rt) throw new Error("runtime action trace is unavailable");
    return await rt.getActionRunTrace();
  });
}

const p95 = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
};

(SERVER_EXECUTION_ENABLED ? describe : describe.ignore)(
  "server-primary browser rollout measurement",
  () => {
    const actorShell = new ShellIntegration();
    const lazyShell = new ShellIntegration();
    actorShell.bindLifecycle();
    lazyShell.bindLifecycle();

    let actorIdentity: Identity;
    let lazyIdentity: Identity;
    let creator: PiecesController;
    let policyOwner: PiecesController;
    let pieceId: string;
    let doubledEntityId: string;
    let resultSinkCancel: (() => void) | undefined;

    beforeAll(async () => {
      [actorIdentity, lazyIdentity] = await Promise.all([
        Identity.generate({ implementation: "noble" }),
        Identity.generate({ implementation: "noble" }),
      ]);
      creator = await initializePiecesController({
        spaceName: SPACE_NAME,
        apiUrl: new URL(API_URL),
        identity: actorIdentity,
      });
      const spaceIdentity = await (await Identity.fromPassphrase("common user"))
        .derive(SPACE_NAME);
      policyOwner = await initializePiecesController({
        spaceName: SPACE_NAME,
        apiUrl: new URL(API_URL),
        identity: spaceIdentity,
      });
      await creator.ensureDefaultPattern();
      const sourcePath = join(
        import.meta.dirname!,
        "fixtures",
        "server-primary-rollout.tsx",
      );
      const program = await creator.manager().runtime.harness.resolve(
        new FileSystemProgramResolver(
          sourcePath,
          join(import.meta.dirname!, ".."),
        ),
      );
      const piece = await creator.create(program, { start: true });
      pieceId = piece.id;
      const result = creator.manager().getResult(piece.getCell());
      doubledEntityId = result.key("doubled").getAsNormalizedFullLink().id;
      resultSinkCancel = result.sink(() => {});
      await writePolicy(policyOwner, false);
    });

    afterAll(async () => {
      await writePolicy(policyOwner, false).catch(() => {});
      resultSinkCancel?.();
      await Promise.all([creator?.dispose(), policyOwner?.dispose()]);
    });

    it("keeps lazy-client compute no worse while claimed writes leave the browser wire", async () => {
      const actorPage = actorShell.page();
      const lazyPage = lazyShell.page();
      const view = { spaceName: SPACE_NAME, pieceId };
      await Promise.all([
        actorShell.goto({
          frontendUrl: FRONTEND_URL,
          view,
          identity: actorIdentity,
        }),
        lazyShell.goto({
          frontendUrl: FRONTEND_URL,
          view,
          identity: lazyIdentity,
        }),
      ]);
      await Promise.all([
        waitForRuntimeIdle(actorPage, { timeout: TIMEOUT }),
        waitForRuntimeIdle(lazyPage, { timeout: TIMEOUT }),
      ]);
      await Promise.all([
        waitForText(actorPage, "#rollout-doubled", "doubled:0"),
        waitForText(lazyPage, "#rollout-doubled", "doubled:0"),
      ]);

      let expectedCount = 0;
      const clickAndSettle = async () => {
        expectedCount += 1;
        await clickCfButton(actorPage, "#rollout-increment");
        await Promise.all([
          waitForText(
            actorPage,
            "#rollout-doubled",
            `doubled:${expectedCount * 2}`,
            {
              timeout: TIMEOUT,
            },
          ),
          waitForText(
            lazyPage,
            "#rollout-doubled",
            `doubled:${expectedCount * 2}`,
            {
              timeout: TIMEOUT,
            },
          ),
        ]);
        await Promise.all([
          waitForRuntimeIdle(actorPage, { timeout: TIMEOUT }),
          waitForRuntimeIdle(lazyPage, { timeout: TIMEOUT }),
        ]);
      };

      let profiler: CdpWorkerProfiler | undefined;
      if (CPU_BENCH) {
        profiler = await CdpWorkerProfiler.connect(lazyShell.wsEndpoint());
        await profiler.waitForWorker("worker-runtime");
      }

      const runPhase = async (
        label: string,
        policyEnabled: boolean,
      ): Promise<PhaseResult> => {
        const beforePolicy = await executionHealth();
        const claimsIssuedBefore = controlCount(beforePolicy, "claimsIssued");
        const claimsRevokedBefore = controlCount(beforePolicy, "claimsRevoked");
        const hadLiveClaims = claimsIssuedBefore > claimsRevokedBefore;
        await writePolicy(policyOwner, policyEnabled);

        if (policyEnabled) {
          // Aggregate claim counters also include the shell's default pieces.
          // Drive this exact transformed action until the actor proves it has
          // integrated the claim by retaining a derived transaction locally.
          // Every attempt here is excluded from the measured window.
          const warmupBefore = await collectBrowserLoadSummary(
            actorPage,
            `${label}-warmup-before`,
          );
          let exactClaimObserved = false;
          for (let attempt = 0; attempt < 12; attempt++) {
            await clickAndSettle();
            const warmupAfter = await collectBrowserLoadSummary(
              actorPage,
              `${label}-warmup-${attempt + 1}`,
            );
            if (
              warmupAfter.churn.clientDerivedSuppressed >
                warmupBefore.churn.clientDerivedSuppressed
            ) {
              exactClaimObserved = true;
              break;
            }

            const progressBefore = await executionHealth();
            const issuedBefore = controlCount(progressBefore, "claimsIssued");
            const acceptedBefore = controlCount(
              progressBefore,
              "acceptedActionAttempts",
            );
            // Candidate discovery and claim-feed delivery are asynchronous to
            // browser idle. Give the host a bounded chance to make progress,
            // then invalidate again so a newly discovered candidate is
            // reoffered even when unrelated claims are already live.
            await waitFor(
              async () => {
                const health = await executionHealth();
                return controlCount(health, "claimsIssued") > issuedBefore ||
                  controlCount(health, "acceptedActionAttempts") >
                    acceptedBefore;
              },
              { timeout: 5_000, delay: 100 },
            ).catch(() => {});
          }
          assert(
            exactClaimObserved,
            `host never claimed the exact browser action: ${
              JSON.stringify({
                claimsIssuedBefore,
                claimsRevokedBefore,
                health: await executionHealth(),
              })
            }`,
          );
        } else {
          await clickAndSettle();
        }

        if (!policyEnabled && hadLiveClaims) {
          await waitFor(
            async () =>
              controlCount(await executionHealth(), "claimsRevoked") >
                claimsRevokedBefore,
            { timeout: TIMEOUT, delay: 100 },
          );
        }

        await resetActionTrace(actorPage);
        const loadBefore = await collectBrowserLoadSummary(
          actorPage,
          `${label}-before`,
        );
        const healthBefore = await executionHealth();
        let profile: CPUProfile | undefined;
        if (profiler) await profiler.start("worker-runtime");
        const actionRuns: number[] = [];
        const observedActionWrites = new Set<string>();
        for (let index = 0; index < CPU_EVENTS; index++) {
          const traceBefore = (await actionTrace(actorPage)).length;
          await clickAndSettle();
          const delta = (await actionTrace(actorPage)).slice(traceBefore);
          for (const entry of delta) {
            for (const write of entry.actualWrites) {
              observedActionWrites.add(
                `${entry.actionId}:${write.entityId}:${write.path.join("/")}`,
              );
            }
          }
          actionRuns.push(
            delta.filter((entry) => entry.actualWrites.length > 0).length,
          );
        }
        if (profiler) profile = await profiler.stop();
        if (policyEnabled) {
          const acceptedBefore = controlCount(
            healthBefore,
            "acceptedActionAttempts",
          );
          await waitFor(
            async () =>
              controlCount(
                await executionHealth(),
                "acceptedActionAttempts",
              ) > acceptedBefore,
            { timeout: TIMEOUT, delay: 100 },
          );
        }
        const loadAfter = await collectBrowserLoadSummary(
          actorPage,
          `${label}-after`,
        );
        const healthAfter = await executionHealth();
        const result: PhaseResult = {
          label,
          policyEnabled,
          events: CPU_EVENTS,
          actionRuns,
          clientDerivedSuppressed: loadAfter.churn.clientDerivedSuppressed -
            loadBefore.churn.clientDerivedSuppressed,
          clientDerivedUpstreamCommits:
            loadAfter.churn.clientDerivedUpstreamCommits -
            loadBefore.churn.clientDerivedUpstreamCommits,
          serverAcceptedActionAttempts:
            controlCount(healthAfter, "acceptedActionAttempts") -
            controlCount(healthBefore, "acceptedActionAttempts"),
          observedActionWrites: [...observedActionWrites].sort(),
          ...(profile ? { cpu: summarizeCPUProfile(profile) } : {}),
        };
        if (profile && PROFILE_DIR) {
          await Deno.mkdir(PROFILE_DIR, { recursive: true });
          await Deno.writeTextFile(
            join(PROFILE_DIR, `${label}.cpuprofile`),
            JSON.stringify(profile),
          );
        }
        return result;
      };

      try {
        const baseline = await runPhase("policy-disabled", false);
        const enabled = await runPhase("policy-enabled", true);

        assert(
          baseline.actionRuns.every((runs) => runs > 0),
          `baseline missed doubled action: ${
            JSON.stringify({
              doubledEntityId,
              actionRuns: baseline.actionRuns,
              observedActionWrites: baseline.observedActionWrites,
            })
          }`,
        );
        assert(
          p95(enabled.actionRuns) <= p95(baseline.actionRuns),
          `enabled lazy-client p95 action runs ${
            p95(enabled.actionRuns)
          } exceeded baseline ${p95(baseline.actionRuns)}`,
        );
        assert(
          enabled.clientDerivedSuppressed > 0,
          `enabled phase did not suppress claimed browser writes: ${
            JSON.stringify(enabled)
          }`,
        );
        assertEquals(enabled.clientDerivedUpstreamCommits, 0);
        assert(enabled.serverAcceptedActionAttempts > 0);

        const phases = [baseline, enabled];
        if (CPU_BENCH) {
          const enabledRepeat = await runPhase("policy-enabled-repeat", true);
          const baselineRepeat = await runPhase(
            "policy-disabled-repeat",
            false,
          );
          phases.push(enabledRepeat, baselineRepeat);
          for (const phase of phases) {
            assert(
              (phase.cpu?.sampledUs ?? 0) > 0,
              `${phase.label} CPU profile contained no valid samples`,
            );
            assert(
              (phase.cpu?.busyUs ?? 0) > 0,
              `${phase.label} CPU profile contained no worker activity`,
            );
          }
          const aggregateBusyPerEvent = (selected: PhaseResult[]): number =>
            selected.reduce(
              (total, phase) => total + (phase.cpu?.busyUs ?? 0),
              0,
            ) / selected.reduce((total, phase) => total + phase.events, 0);
          const baselineAggregate = aggregateBusyPerEvent([
            baseline,
            baselineRepeat,
          ]);
          const enabledAggregate = aggregateBusyPerEvent([
            enabled,
            enabledRepeat,
          ]);
          assert(
            enabledAggregate <= baselineAggregate * 1.1,
            `enabled sampled busy time/event ${enabledAggregate}us exceeded baseline ${baselineAggregate}us by more than 10%`,
          );
        }

        const health = await executionHealth();
        assert(
          (health.serverExecutionPool?.activeWorkers ?? 0) >= 1,
          `shared executor was not live: ${JSON.stringify(health)}`,
        );
        assert(
          (health.serverExecutionPool?.activeDemands ?? 0) >= 2,
          `browser demand was not retained: ${JSON.stringify(health)}`,
        );
        if (PROFILE_DIR) {
          await Deno.mkdir(PROFILE_DIR, { recursive: true });
          await Deno.writeTextFile(
            join(PROFILE_DIR, "server-primary-rollout-summary.json"),
            JSON.stringify(
              {
                capturedAt: new Date().toISOString(),
                space: SPACE_NAME,
                doubledEntityId,
                phases,
                health,
              },
              null,
              2,
            ),
          );
        }
      } finally {
        profiler?.close();
      }
    });
  },
);
