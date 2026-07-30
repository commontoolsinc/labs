/**
 * navigate-to-server-side.md §5 item 2 / §6 item 2 — THE rank-containment
 * invariant, and the design's own safety hinge.
 *
 * `navigateTo` re-keys its result cell to SESSION scope
 * (`builtins/navigate-to.ts`, `createCell(..., scope: "session")`). Everything
 * that keeps a server-side navigation from becoming a broadcast hangs off that
 * one fact reaching the DECLARED surface:
 *
 *   - `laneAdmitsScope` (`scheduler/servability.ts`) admits a `session`-declared
 *     address ONLY at session lane rank, so the action classifies unservable at
 *     user rank and at space rank;
 *   - space-rank delivery has NO principal filter — the principal comparison in
 *     `#sessionAcceptsClaim` (`packages/memory/v2/server.ts`) sits INSIDE the
 *     `contextKey !== "space"` branch — so a space-rank navigate claim would
 *     drag every co-tenant of a shared space to a piece one of them opened;
 *   - a session-rank claim's contextKey is `session:<did>:<sid>`, which the
 *     same predicate narrows to exactly one session.
 *
 * So cross-principal navigation is not "undesirable and avoided", it is
 * STRUCTURALLY UNREACHABLE — provided the session-scoped write stays in the
 * declared surface. §6 item 2 is the falsifier: if the generically-minted
 * `ServerBuiltinActionDescriptor` omits it, `noteScopedSurface` never fires,
 * `contextRank` stays absent, the action becomes space rank, and the broadcast
 * becomes reachable. This file is the tripwire for exactly that.
 *
 * It measures rather than reasons: the surface comes from the REAL executor
 * router (`prepareSupportedBuiltinObservation` assembles the effect summary
 * from the descriptor), driven by a real `return navigateTo(Room({}))` handler
 * — `packages/patterns/group-chat-lobby.tsx:154` in miniature, the same fixture
 * shape `navigate-demand-closure-probe.test.ts` uses.
 *
 * Modeled on `sqlite-database-servability.test.ts` (real router + static
 * classifier) and `scheduler-servability.test.ts` (the classification shapes).
 */
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import {
  createExecutorActionTransactionRouter,
  type ExecutorCandidateDiagnostic,
} from "../src/executor/action-transaction-router.ts";
import { classifyStaticActionServability } from "../src/scheduler/servability.ts";
import type { SchedulerActionObservation } from "../src/scheduler/persistent-observation.ts";
import type { ServerBuiltinActionDescriptor } from "../src/builtins/server-execution.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";

const scopeOf = (address: { readonly scope?: unknown }): string =>
  typeof address.scope === "string" ? address.scope : "space";

type NavigateAttempt = {
  readonly observation: SchedulerActionObservation;
  readonly descriptor: ServerBuiltinActionDescriptor | undefined;
};

/**
 * Fire one `return navigateTo(Room({}))` handler and capture every action-run
 * observation whose implementation identity is `navigateTo`'s — matched on the
 * id PREFIX, not the full fingerprint, so the capture works both before and
 * after the builtin earns `:server-v1`. A capture keyed on `:server-v1` would
 * find nothing while the identity is still `:v1` and the suite would go green
 * by measuring zero runs.
 */
async function observeNavigateTo(): Promise<{
  attempts: NavigateAttempt[];
  diagnostics: ExecutorCandidateDiagnostic[];
  navigations: string[];
  space: MemorySpace;
}> {
  const signer = await Identity.fromPassphrase(
    "navigateTo rank containment invariant",
  );
  const space = signer.did() as MemorySpace;
  const attempts: NavigateAttempt[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const navigations: string[] = [];
  const executorRouter = createExecutorActionTransactionRouter({
    servedSpace: space,
    branch: "",
    claimForAction: () => undefined,
    onCandidate: () => {},
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const storage = StorageManager.emulate({
    as: signer,
    actionTransactionRouter(input) {
      const route = executorRouter(input);
      const observation = input.commit.schedulerObservation;
      const fingerprint =
        (observation as { implementationFingerprint?: unknown })
          ?.implementationFingerprint;
      if (
        observation !== undefined &&
        (observation as { transactionKind?: unknown }).transactionKind ===
          "action-run" &&
        typeof fingerprint === "string" &&
        fingerprint.startsWith("impl:cf:builtin/navigateTo:")
      ) {
        const declared = (input.sourceAction as {
          serverBuiltin?: ServerBuiltinActionDescriptor;
        } | undefined)?.serverBuiltin;
        attempts.push({
          observation: structuredClone(
            observation,
          ) as SchedulerActionObservation,
          descriptor: declared === undefined
            ? undefined
            : structuredClone(declared) as ServerBuiltinActionDescriptor,
        });
      }
      return route;
    },
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: {
      persistentSchedulerState: true,
      serverPrimaryExecution: true,
    },
    navigateCallback: (target) => {
      navigations.push(target.getAsNormalizedFullLink().id);
    },
  });
  try {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, navigateTo, pattern } = commonfabric;
    const Room = pattern(() => ({ title: "rank containment room" }));
    const openRoom = handler(
      { type: "object", properties: {} },
      { type: "object", properties: {} },
      // packages/patterns/group-chat-lobby.tsx:154 in miniature.
      () => navigateTo(Room({})),
    );
    const Lobby = pattern(() => ({ openRoom: openRoom({}) }));

    const setupTx = runtime.edit();
    const lobbyCell = runtime.getCell<{ openRoom: unknown }>(
      space,
      "navigateTo rank containment lobby",
      undefined,
      setupTx,
    );
    const lobby = runtime.run(setupTx, Lobby, {}, lobbyCell);
    runtime.prepareTxForCommit(setupTx);
    assertEquals((await setupTx.commit()).error, undefined);
    await lobby.pull();

    lobby.key("openRoom").send({});
    await runtime.settled();

    // The navigation really happened; otherwise every leg below measures an
    // action that never ran (the wave-B instrument-blindness lesson).
    assertEquals(
      navigations.length,
      1,
      "the fixture must actually navigate exactly once",
    );
    assert(
      attempts.length > 0,
      "no navigateTo action-run was observed at all — the capture predicate " +
        "or the fixture is broken, not the invariant",
    );
    return { attempts, diagnostics, navigations, space };
  } finally {
    await runtime.dispose();
    await storage.close();
  }
}

Deno.test("§6.2: navigateTo declares a session-scoped write in its assembled surface", async () => {
  const { attempts, space } = await observeNavigateTo();

  console.log(
    "[navigate-rank-containment]",
    JSON.stringify({
      runs: attempts.length,
      fingerprints: [
        ...new Set(
          attempts.map((attempt) =>
            attempt.observation.implementationFingerprint
          ),
        ),
      ],
      actionKinds: [
        ...new Set(attempts.map((attempt) => attempt.observation.actionKind)),
      ],
      withDescriptor: attempts.filter((attempt) =>
        attempt.descriptor !== undefined
      ).length,
      withSummary: attempts.filter((attempt) =>
        attempt.observation.completeActionScopeSummary !== undefined
      ).length,
      classifications: attempts.map((attempt) => ({
        none: classifyStaticActionServability(attempt.observation, space),
        user: classifyStaticActionServability(attempt.observation, space, {
          userContext: true,
        }),
        session: classifyStaticActionServability(attempt.observation, space, {
          sessionContext: true,
        }),
      })),
    }),
  );

  for (const { observation, descriptor } of attempts) {
    // §2.7 item 6 / navigate-to.ts's `isEffect: true`: it is an EFFECT node at
    // runtime whatever `builtins/index.ts` registers, so the descriptor route
    // it can take is the EFFECT one and the failure code when the surface is
    // missing is `unknown-effect-surface`, never `incomplete-static-surface`.
    assertEquals(observation.actionKind, "effect");
    // The exact fingerprint `supportedBuiltinDescriptor` keys on. Without it no
    // descriptor is honored and no summary is ever assembled.
    assertEquals(
      observation.implementationFingerprint,
      "impl:cf:builtin/navigateTo:server-v1",
    );

    assert(
      descriptor !== undefined,
      "navigateTo must carry a generically-minted ServerBuiltinActionDescriptor",
    );
    // THE HINGE. The session-scoped result instance must be in the DECLARED
    // surface, not merely in what some particular run happened to write:
    // `contextRank` must be a property of the declaration, not a contingency of
    // one observation.
    const declaredWrites = [...descriptor.writes, ...descriptor.runtimeWrites];
    const declaredSessionWrites = declaredWrites.filter((link) =>
      scopeOf(link) === "session"
    );
    assert(
      declaredSessionWrites.length > 0,
      "the descriptor's declared write surface must name the session-scoped " +
        `result instance; saw ${
          JSON.stringify(
            declaredWrites.map((link) => ({
              scope: scopeOf(link),
              id: link.id,
              path: link.path,
            })),
          )
        }`,
    );

    const summary = observation.completeActionScopeSummary;
    assert(
      summary !== undefined,
      "the executor router must assemble a complete surface from the descriptor",
    );
    const summaryWrites = summary.writes as readonly IMemorySpaceAddress[];
    assert(
      summaryWrites.some((address) => scopeOf(address) === "session"),
      "the assembled write surface must carry the session-scoped instance",
    );
  }
});

Deno.test("§6.2: navigateTo classifies at SESSION rank in a session lane, and nowhere else", async () => {
  const { attempts, space } = await observeNavigateTo();

  for (const { observation } of attempts) {
    // (1) Under a SESSION lane the effect is servable AT SESSION RANK. The
    //     reported rank is what the CA9 filter routes on, so it is what pins
    //     the claim's contextKey to `session:<did>:<sid>` — and therefore what
    //     makes the delivery predicate narrow the navigation to one session.
    assertEquals(
      classifyStaticActionServability(observation, space, {
        sessionContext: true,
      }),
      {
        status: "broker-required",
        actionKind: "effect",
        contextRank: "session",
      },
    );

    // (2) Under a USER lane, and (3) under NO lane, it is UNSERVABLE. This is
    //     the containment: a user-rank claim would reach every session of the
    //     principal, and a space-rank claim would reach every principal in the
    //     space (space-rank delivery has no principal filter at all). Neither
    //     is reachable while the session-scoped surface stays declared.
    //
    //     The REASON is measured, not assumed. navigateTo both READS its
    //     session-scoped result cell (the "already navigated" guard) and WRITES
    //     it, and the classifier's read loop runs before its write loop, so the
    //     first scope rejection it reports is the READ. The design predicted
    //     `non-space-write-scope`; the truthful code is `non-space-read-scope`.
    //     Either way the action is unservable off session rank, which is the
    //     property that matters — but assert the label that actually fires so
    //     this file never drifts into asserting a fiction.
    for (const lane of [undefined, { userContext: true }] as const) {
      assertEquals(
        classifyStaticActionServability(observation, space, lane),
        { status: "unservable", reason: "non-space-read-scope" },
      );
    }
  }
});
