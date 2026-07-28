/**
 * §5f follow-up probe: what the USER-RANK dial actually buys the group-chat
 * product's computation inventory, measured at the executor router seam.
 *
 * WHY THIS FILE EXISTS. §5f of docs/specs/server-side-execution/
 * client-passivity.md closed the `malformed-output-surface` labeling defect
 * and left the live chat-leg inventory at `non-space-read-scope` ×191 across
 * 20 offender actions — scoped UI derivations (profile labels, send-button
 * booleans, participant rosters) that are unservable at SPACE rank and
 * nothing else. The taxonomy pass behind that paragraph reported "14/15
 * in-fixture offenders would classify claim-ready at USER rank"; that number
 * was produced in an isolated worktree and never landed as a re-runnable
 * artifact. This probe lands it: the same real product, driven through the
 * same router seam the executor Worker uses, with the rank dials as the ONLY
 * difference between arms.
 *
 * SHAPE. Deliberately the C2.10 `driveLunchPollThroughRouter` shape from
 * server-execution-product-fixtures.test.ts — emulated storage, a real
 * compiled `cfc-group-chat-demo/main.tsx`, the real
 * `createExecutorActionTransactionRouter`, and a workload that drives the
 * product's own PerUser/PerSession surfaces (profile draft → save, message
 * draft → trusted send, room draft → trusted add). No server, no pool, no
 * Worker: this is the CLASSIFICATION half. The live half — claims actually
 * issued, settled, and isolated across two principals against a real Server
 * — is the integration gate's (packages/patterns/integration).
 *
 * WHAT IT PINS. Three arms over one workload:
 *   - space  (both dials off): the deployed default. The scoped derivations
 *     are unservable, and the reason codes are the live inventory's classes.
 *   - user   (`userRankCandidates`): the C1.5a dial alone.
 *   - session (`userRankCandidates` + `sessionRankCandidates`): the C2.5
 *     ladder step above it.
 * The assertions are the DIRECTION and the DISCRIMINATOR — scoped candidates
 * appear only with a dial on, every scoped candidate names an open lane
 * (CA9), and the space arm produces none — plus a printed taxonomy so a
 * re-run reproduces the memo's numbers rather than re-deriving them by hand.
 * The exact offender counts are NOT asserted: they move with the product,
 * and pinning them here would make an unrelated pattern edit fail this file
 * instead of telling whoever changed it something true.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  sessionExecutionContextKey,
  userExecutionContextKey,
} from "@commonfabric/memory/v2";
import { Runtime } from "../src/runtime.ts";
import { markRendererTrustedEvent } from "../src/cfc/mod.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  createExecutorActionTransactionRouter,
  type ExecutorCandidateDiagnostic,
} from "../src/executor/action-transaction-router.ts";
import type { CandidateClaim } from "../src/executor/deno-space-executor.ts";

const PATTERNS_ROOT = join(import.meta.dirname!, "../../patterns");
const GROUP_CHAT = join(PATTERNS_ROOT, "cfc-group-chat-demo/main.tsx");

// Trusted surface/action names from cfc-group-chat-demo/trusted.tsx, inlined
// exactly as cfc-group-chat-demo-multi-runtime.test.ts inlines them (so this
// probe does not compile the pattern module into the test process).
const PROFILE_SURFACE = "TrustedGroupChatProfileSurface";
const SAVE_PROFILE_ACTION = "TrustedGroupChatSaveProfile";
const SEND_SURFACE = "TrustedGroupChatSendSurface";
const SEND_ACTION = "TrustedGroupChatSendMessage";
const ROOM_SURFACE = "TrustedGroupChatRoomSurface";
const ADD_ROOM_ACTION = "TrustedGroupChatAddRoom";

/**
 * The event a genuine user interaction on a trusted surface delivers: DOM
 * provenance plus the renderer-trusted mark the html worker reconciler
 * applies. Verbatim in effect from `multi-runtime-worker.ts`'s `send` — the
 * group-chat trusted handlers reject anything else with
 * `cfc-relevant-transaction-not-prepared`, which would silently drop the
 * workload's writes and leave this probe classifying a piece nobody used.
 */
const trustedEvent = (surface: string, action: string): unknown => {
  const event = {
    type: "click",
    provenance: {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: surface,
        eventIntegrity: [surface],
        uiContractDataset: { uiAction: action },
      },
    },
  };
  markRendererTrustedEvent(event);
  return event;
};

/** The rank ladder arms this probe measures; `space` is today's deployed
 * default (both dials off). */
type RankArm = "space" | "user" | "session";

type ArmResult = {
  readonly arm: RankArm;
  readonly candidates: CandidateClaim[];
  readonly diagnostics: ExecutorCandidateDiagnostic[];
  readonly userLane: string;
  readonly sessionLane: string;
};

/**
 * Drive the real group-chat product through the real executor router with the
 * rank dials set for `arm`, and return every candidate and diagnostic the
 * router produced.
 *
 * The identity is derived from a fixed passphrase per arm so a re-run
 * reproduces the same space DID and the arms stay comparable; the workload
 * below is identical in every arm by construction (one code path, no
 * arm-conditional steps).
 */
const driveGroupChatThroughRouter = async (
  arm: RankArm,
): Promise<ArmResult> => {
  // ONE identity and ONE result-cell name across every arm. Action ids embed
  // the piece instance, so an arm-varying space DID or cell name would make
  // the arms' action-id sets disjoint and every cross-arm set relation below
  // vacuously zero. The arms run sequentially over independent emulated
  // stores, so sharing the identity costs nothing.
  const signer = await Identity.fromPassphrase(
    "server execution group-chat rank probe",
  );
  const space = signer.did() as MemorySpace;
  const userLane = userExecutionContextKey(signer.did());
  const sessionLane = sessionExecutionContextKey(
    signer.did(),
    "group-chat-rank-probe-session-1",
  );
  const candidates: CandidateClaim[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  // The lane keys the host's grant machinery would supply (C1.9c /
  // review CA9: the executor never fabricates a lane key). The `space` arm
  // passes none of this, exactly as the deployed default does.
  const laneOptions = arm === "space" ? {} : {
    userRankCandidates: true,
    ...(arm === "session" ? { sessionRankCandidates: true } : {}),
    lanePrincipal: signer.did(),
    openUserLaneKeys: () =>
      arm === "session" ? [sessionLane, userLane] : [userLane],
  };
  const router = createExecutorActionTransactionRouter({
    servedSpace: space,
    branch: "",
    ...laneOptions,
    claimForAction: () => undefined,
    onCandidate: (candidate) => candidates.push(candidate),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const storage = StorageManager.emulate({
    as: signer,
    actionTransactionRouter: (input) => router(input),
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: {
      persistentSchedulerState: true,
      serverPrimaryExecution: true,
    },
    trustSnapshotProvider: () => ({
      id: `principal:${space}`,
      actingPrincipal: space,
    }),
  });
  try {
    const program = await runtime.harness.resolve(
      new FileSystemProgramResolver(GROUP_CHAT, PATTERNS_ROOT),
    );
    const compiled = await runtime.patternManager.compilePattern(program, {
      space,
    });
    const tx = runtime.edit();
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "group-chat-rank-probe-result",
      undefined,
      tx,
    );
    const handle = runtime.run(tx, compiled, {}, result);
    runtime.prepareTxForCommit(tx);
    assertEquals((await tx.commit()).error, undefined);
    await handle.pull();
    await runtime.settled();

    // The chat leg's own workload, in the order a browser drives it: name
    // yourself, post, add a room. Every step re-runs the scoped derivations
    // §5f named as the offenders (currentProfileName, the send-button
    // booleans, the roster projections).
    const step = async (fn: () => void) => {
      fn();
      await runtime.idle();
      await runtime.settled();
    };
    const trustedStep = (handler: string, surface: string, action: string) =>
      step(() =>
        handle.key(handler).send(
          trustedEvent(surface, action) as never,
        )
      );
    await step(() => handle.key("setProfileDraft").send("Alice"));
    await trustedStep("saveProfile", PROFILE_SURFACE, SAVE_PROFILE_ACTION);
    await step(() => handle.key("setRoomDraft").send("Ops"));
    await trustedStep("addTrustedRoom", ROOM_SURFACE, ADD_ROOM_ACTION);
    await step(() => handle.key("setMessageDraft").send("hello from Alice"));
    await trustedStep("sendTrustedMessage", SEND_SURFACE, SEND_ACTION);
    await step(() => handle.key("setMessageDraft").send("second message"));
    await trustedStep("sendTrustedMessage", SEND_SURFACE, SEND_ACTION);

    // The workload must have actually landed, or the arms are comparing an
    // unused piece: the profile name is the product's own PerUser label and
    // the message list is its PerSpace log.
    assertEquals(await handle.key("currentProfileName").pull(), "Alice");
    const posted = await handle.key("messages").pull() as
      | readonly unknown[]
      | undefined;
    assertEquals(posted?.length, 2, "the trusted sends did not land");
  } finally {
    await runtime.dispose();
    await storage.close();
  }
  return { arm, candidates, diagnostics, userLane, sessionLane };
};

/**
 * Diagnostics grouped by reason code.
 *
 * `events` is `/api/health/stats`'s `candidateUnservedByCode` number.
 * `actions` counts distinct raw action ids — the "×N offenders" number §5f
 * reports. `derivations` collapses per-instance action ids to their module +
 * lift identity ({@link derivationKey}); the two differ whenever one
 * derivation runs at several instances, and reading `actions` as
 * "distinct derivations" is exactly the mistake that makes an inventory look
 * larger than the code surface behind it.
 */
const inventory = (
  diagnostics: readonly ExecutorCandidateDiagnostic[],
): Record<
  string,
  { events: number; actions: number; derivations: number }
> => {
  const byCode = new Map<
    string,
    { events: number; actions: Set<string>; derivations: Set<string> }
  >();
  for (const diagnostic of diagnostics) {
    const entry = byCode.get(diagnostic.diagnosticCode) ?? {
      events: 0,
      actions: new Set<string>(),
      derivations: new Set<string>(),
    };
    entry.events += 1;
    const actionId = diagnostic.claimKey?.actionId;
    if (actionId !== undefined) {
      entry.actions.add(actionId);
      entry.derivations.add(derivationKey(actionId));
    }
    byCode.set(diagnostic.diagnosticCode, entry);
  }
  return Object.fromEntries(
    [...byCode.entries()]
      .sort((a, b) => b[1].events - a[1].events)
      .map(([code, entry]) => [code, {
        events: entry.events,
        actions: entry.actions.size,
        derivations: entry.derivations.size,
      }]),
  );
};

const candidatesByContextKey = (
  candidates: readonly CandidateClaim[],
): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const candidate of candidates) {
    const key = candidate.claimKey.contextKey.startsWith("session:")
      ? "session:<lane>"
      : candidate.claimKey.contextKey.startsWith("user:")
      ? "user:<lane>"
      : candidate.claimKey.contextKey;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

const distinctActions = (
  diagnostics: readonly ExecutorCandidateDiagnostic[],
  code: string,
): Set<string> =>
  new Set(
    diagnostics
      .filter((diagnostic) => diagnostic.diagnosticCode === code)
      .flatMap((diagnostic) =>
        diagnostic.claimKey === undefined
          ? []
          : [derivationKey(diagnostic.claimKey.actionId)]
      ),
  );

/**
 * The DERIVATION identity of an action id, stable across arms.
 *
 * Action ids read `cf:module/<hash>:<liftName>:<instance>`; the trailing
 * instance segment is minted per Runtime, so the raw id cannot be compared
 * between two arms that each build their own Runtime. The module hash plus
 * lift name is what "the same derivation" means here, and is the granularity
 * the offender inventory is actually about. Ids that do not have that shape
 * pass through unchanged.
 */
const derivationKey = (actionId: string): string => {
  const parts = actionId.split(":");
  return parts.length > 3 ? parts.slice(0, 3).join(":") : actionId;
};

/** Every derivation the arm produced a candidate for, at any rank. */
const candidateActions = (result: ArmResult): Set<string> =>
  new Set(
    result.candidates.map((candidate) =>
      derivationKey(candidate.claimKey.actionId)
    ),
  );

/** Every action the arm stranded, mapped to the codes that stranded it.
 * Ownerless diagnostics (no `claimKey`) are excluded — they name no action
 * and are identical across arms. */
const strandedActions = (
  result: ArmResult,
): Map<string, Set<string>> => {
  const byAction = new Map<string, Set<string>>();
  for (const diagnostic of result.diagnostics) {
    const raw = diagnostic.claimKey?.actionId;
    if (raw === undefined) continue;
    const actionId = derivationKey(raw);
    const codes = byAction.get(actionId) ?? new Set<string>();
    codes.add(diagnostic.diagnosticCode);
    byAction.set(actionId, codes);
  }
  return byAction;
};

/**
 * The four set relations that decide whether a rank dial is a WIN, a WASH, or
 * a REGRESSION — the question the raw per-code counts cannot answer, because
 * an arm can strand a derivation the control never even routed.
 *
 * `promoted` — stranded in the control, claim-ready in the arm: the buy.
 * `stillStranded` — stranded in both: unchanged, whatever the code says.
 * `appeared` — stranded in the arm, ABSENT from the control's candidate AND
 *   diagnostic sets: a derivation the space-only default never classified at
 *   all, which the dial pulls into the routing seam and the §4 lane
 *   write-shape firewall then rejects. Not a regression of placement, but new
 *   unserved inventory that only exists because the dial is on.
 * `regressed` — claim-ready in the control, stranded in the arm: the dial
 *   took working placement away. Must be empty.
 */
const rankDelta = (control: ArmResult, arm: ArmResult) => {
  const controlReady = candidateActions(control);
  const armReady = candidateActions(arm);
  const controlStranded = strandedActions(control);
  const armStranded = strandedActions(arm);
  const promoted = [...controlStranded.keys()].filter((actionId) =>
    armReady.has(actionId) && !controlReady.has(actionId)
  );
  const stillStranded = [...armStranded.entries()].flatMap((
    [actionId, codes],
  ) =>
    controlStranded.has(actionId) && !armReady.has(actionId)
      ? [{
        actionId,
        from: [...controlStranded.get(actionId)!],
        to: [...codes],
      }]
      : []
  );
  const appeared = [...armStranded.entries()].flatMap(([actionId, codes]) =>
    !controlStranded.has(actionId) && !controlReady.has(actionId)
      ? [{ actionId, codes: [...codes] }]
      : []
  );
  const regressed = [...armStranded.entries()].flatMap(([actionId, codes]) =>
    controlReady.has(actionId) && !armReady.has(actionId)
      ? [{ actionId, codes: [...codes] }]
      : []
  );
  // The bucket the four relations above deliberately do not own: a
  // derivation that is claim-ready in the arm AND stranded in it. Placement
  // succeeded; individual ATTEMPTS were then rejected — under a lane, by the
  // §4 widening-pair write-shape firewall. This is the claimed-but-unserved
  // shape, and it is invisible to any count that asks only "is this action
  // claim-ready?".
  const mixed = [...armStranded.entries()].flatMap(([actionId, codes]) =>
    armReady.has(actionId) ? [{ actionId, codes: [...codes] }] : []
  );
  return { promoted, stillStranded, appeared, regressed, mixed };
};

const report = (result: ArmResult): void => {
  console.log(
    `group-chat rank probe [${result.arm}] ` +
      `candidates=${
        JSON.stringify(candidatesByContextKey(result.candidates))
      } ` +
      `unserved=${JSON.stringify(inventory(result.diagnostics))}`,
  );
};

Deno.test("group-chat rank probe: the user-rank dial converts the product's scoped-read offenders into claim-ready candidates (§5f follow-up)", async () => {
  // Adjacent arms in one process, identical workload, dials as the only
  // difference — the same discipline the measurement protocol requires of
  // the harness legs.
  const spaceArm = await driveGroupChatThroughRouter("space");
  const userArm = await driveGroupChatThroughRouter("user");
  report(spaceArm);
  report(userArm);

  // The space arm is the control: today's deployed default produces ZERO
  // scoped candidates however many scoped surfaces the product has.
  assertEquals(
    spaceArm.candidates.filter((candidate) =>
      candidate.claimKey.contextKey !== "space"
    ),
    [],
    "the dials-off control produced a scoped candidate",
  );
  assert(
    spaceArm.candidates.some((candidate) =>
      candidate.claimKey.contextKey === "space"
    ),
    "the dials-off control produced no space candidate at all — the " +
      "workload, not the dial, would be the discriminator",
  );

  // The offender class §5f named must actually be present in the control,
  // or this probe is measuring a workload that never reaches the question.
  const spaceOffenders = distinctActions(
    spaceArm.diagnostics,
    "non-space-read-scope",
  );
  assert(
    spaceOffenders.size > 0,
    `the control produced no non-space-read-scope offender: ${
      JSON.stringify(inventory(spaceArm.diagnostics))
    }`,
  );

  // The buy: with the user dial on, the same workload produces user-rank
  // candidates, and every one names the OPEN lane (CA9 — never a key
  // fabricated from the bare DID).
  const userCandidates = userArm.candidates.filter((candidate) =>
    candidate.claimKey.contextKey.startsWith("user:")
  );
  assert(
    userCandidates.length > 0,
    `the user dial produced no user-rank candidate; unserved: ${
      JSON.stringify(inventory(userArm.diagnostics))
    }`,
  );
  assertEquals(
    userCandidates.filter((candidate) =>
      candidate.claimKey.contextKey !== userArm.userLane
    ),
    [],
    "a user-rank candidate named something other than the open user lane",
  );

  // And the inventory moves in the right direction: strictly fewer distinct
  // actions stranded on `non-space-read-scope` than the control had.
  const userOffenders = distinctActions(
    userArm.diagnostics,
    "non-space-read-scope",
  );
  assert(
    userOffenders.size < spaceOffenders.size,
    `the user dial did not reduce the non-space-read-scope offender set ` +
      `(${spaceOffenders.size} → ${userOffenders.size}); unserved: ` +
      JSON.stringify(inventory(userArm.diagnostics)),
  );
  console.log(
    `group-chat rank probe: non-space-read-scope offender actions ` +
      `space=${spaceOffenders.size} user=${userOffenders.size} ` +
      `residual=${JSON.stringify([...userOffenders])}`,
  );

  // The set relations — what the per-code counts alone cannot say.
  const delta = rankDelta(spaceArm, userArm);
  const codeHistogram = (
    entries: ReadonlyArray<{ readonly codes: readonly string[] }>,
  ): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const entry of entries) {
      for (const code of entry.codes) counts[code] = (counts[code] ?? 0) + 1;
    }
    return counts;
  };
  console.log(
    `group-chat rank probe [user vs space] promoted=${delta.promoted.length} ` +
      `stillStranded=${delta.stillStranded.length} ` +
      `appeared=${delta.appeared.length} ` +
      `regressed=${delta.regressed.length} ` +
      `mixed(claim-ready AND stranded)=${delta.mixed.length}\n` +
      `  mixed by code: ${JSON.stringify(codeHistogram(delta.mixed))}\n` +
      `  stillStranded: ${
        JSON.stringify(
          delta.stillStranded.map((e) => ({ from: e.from, to: e.to })),
        )
      }\n` +
      `  appeared by code: ${JSON.stringify(codeHistogram(delta.appeared))}`,
  );
  // The one hard invariant: a rank dial may leave an action stranded, but it
  // must never take away placement the space-only default already had.
  assertEquals(
    delta.regressed,
    [],
    "the user-rank dial stranded an action that was claim-ready at space rank",
  );
});

Deno.test("group-chat rank probe: the session dial clears the user arm's residual scoped-read offenders (the C2.5 ladder step)", async () => {
  const userArm = await driveGroupChatThroughRouter("user");
  const sessionArm = await driveGroupChatThroughRouter("session");
  report(sessionArm);

  const userOffenders = distinctActions(
    userArm.diagnostics,
    "non-space-read-scope",
  );
  const sessionOffenders = distinctActions(
    sessionArm.diagnostics,
    "non-space-read-scope",
  );
  // The ladder: the session arm admits the user arm's admissions too
  // (context-lattice §2 / review CA3), so its offender set can only shrink.
  assert(
    sessionOffenders.size <= userOffenders.size,
    `the session dial grew the offender set (${userOffenders.size} → ` +
      `${sessionOffenders.size})`,
  );
  const sessionCandidates = sessionArm.candidates.filter((candidate) =>
    candidate.claimKey.contextKey.startsWith("session:")
  );
  assertEquals(
    sessionCandidates.filter((candidate) =>
      candidate.claimKey.contextKey !== sessionArm.sessionLane
    ),
    [],
    "a session-rank candidate named something other than the open session " +
      "lane",
  );
  console.log(
    `group-chat rank probe: non-space-read-scope offender actions ` +
      `user=${userOffenders.size} session=${sessionOffenders.size} ` +
      `residual=${JSON.stringify([...sessionOffenders])}`,
  );
});
