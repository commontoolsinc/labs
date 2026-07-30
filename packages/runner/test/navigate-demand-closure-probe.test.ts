/**
 * Wave-G gate-4 follow-on probe (navigate-to-server-side.md §8/§8b): is the
 * commit-gated deferred navigate result root — the piece that OWNS the
 * `navigateTo` action, and which no `start()` call ever reaches — covered by
 * published execution demand?
 *
 * The measurement is a counter, not an argument. It records every
 * `setExecutionDemand` publication the runtime makes while a
 * `group-chat-lobby.tsx:154`-shaped handler (`return navigateTo(Instance)`)
 * fires, and compares the published root set against the roots the runner
 * actually started (`runner.cancels`).
 *
 * Three roots start here, and the distinction between them is the whole
 * point:
 *   1. the lobby, started explicitly via `runtime.start()`;
 *   2. the deferred navigate RESULT root, commit-gated through one of the two
 *      deferred-root seams — this is the piece whose action is the
 *      `navigateTo` effect, so this is the piece a session lane must cover;
 *   3. the navigate TARGET (`Room({})`), a nested pattern node of (2)
 *      instantiated by `instantiatePatternNode` -> `run()` -> `startWithTx`.
 *
 * (2) must be demanded; (3) must NOT be. §8b names `startWithTx` as
 * deliberately excluded because it is also the child path, and publishing
 * there would put every nested piece on the demand wire. The demand plane
 * has no roll-up (`canonicalSchedulerPieceIdForDemandRoot` only prefixes a
 * scope), so (3)'s absence is a boundary this probe pins, not a leak it
 * tolerates: the target is demanded later, by the shell's own `start()` when
 * the navigation actually lands.
 *
 * The positive leg is load-bearing: the lobby root MUST appear, or the
 * instrument cannot see demand at all and every other leg is vacuous
 * (the wave-B lesson, passivity-arc-orchestration.md §6).
 *
 * Both seams are measured, because which one a handler takes is decided by
 * whether it RETURNS the navigation (`runner.ts:3697` ->
 * `setupDeferredHandlerResultPattern` -> `startAfterSuccessfulCommit`) or
 * merely performs it (`runner.ts:3673` -> `runPatternAfterSuccessfulCommit`,
 * whose root is the receipt cell).
 */
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import type { IStorageProviderWithReplica } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "navigate demand closure probe operator",
);
const space = signer.did();

type DemandProvider = IStorageProviderWithReplica & {
  setExecutionDemand?: (
    branch: string,
    pieces: readonly string[],
  ) => Promise<boolean>;
};

/** Root doc ids the runner has live registrations for, as demand would key
 * them (`NormalizedFullLink.id`), read off the public cancels map whose keys
 * are `${space}/${scope}/${uri}`. */
const startedRootIds = (runtime: Runtime): Set<string> => {
  const ids = new Set<string>();
  for (const key of runtime.runner.cancels.keys()) {
    const uri = key.slice(key.lastIndexOf("/") + 1);
    ids.add(uri);
  }
  return ids;
};

/**
 * Fire one `navigateTo`-from-a-handler and assert the demand relation over
 * the three roots it leaves live.
 *
 * @param seam Label for the log line only.
 * @param returnsNavigation `true` reproduces `group-chat-lobby.tsx:154`
 *   (`return navigateTo(...)`), which routes through
 *   `startAfterSuccessfulCommit`. `false` performs the navigation without
 *   returning it, so the handler result is `undefined` and the runner routes
 *   through `runPatternAfterSuccessfulCommit` instead.
 */
const probeDeferredNavigateDemand = async (
  seam: string,
  returnsNavigation: boolean,
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const navigations: string[] = [];
  const demandCalls: { branch: string; pieces: string[] }[] = [];
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: {
      serverPrimaryExecution: true,
      serverPrimaryExecutionDemandShrinkHoldMs: 30,
    },
    navigateCallback: (target) => {
      navigations.push(target.getAsNormalizedFullLink().id);
    },
  });
  const provider = storageManager.open(space) as DemandProvider;
  provider.setExecutionDemand = (branch, pieces) => {
    demandCalls.push({ branch, pieces: [...pieces] });
    return Promise.resolve(true);
  };

  try {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, navigateTo, pattern } = commonfabric;

    const Room = pattern(() => ({ title: "probe room" }));
    const openRoom = handler(
      { type: "object", properties: {} },
      { type: "object", properties: {} },
      returnsNavigation
        // packages/patterns/group-chat-lobby.tsx:154 in miniature.
        ? () => navigateTo(Room({}))
        : () => {
          navigateTo(Room({}));
        },
    );
    const Lobby = pattern(() => ({ openRoom: openRoom({}) }));

    const setupTx = runtime.edit();
    const lobbyCell = runtime.getCell<{ openRoom: unknown }>(
      space,
      `navigate demand closure probe lobby ${seam}`,
      undefined,
      setupTx,
    );
    const lobby = runtime.run(setupTx, Lobby, {}, lobbyCell);
    await setupTx.commit();
    await lobby.pull();

    // `start()` (runner.ts:1286) is one of the demand publication paths; the
    // deferred-root seams are the other.
    assertEquals(await runtime.start(lobbyCell), true);
    const lobbyId = lobbyCell.getAsNormalizedFullLink().id;
    const demandAfterStart = new Set(demandCalls.at(-1)?.pieces ?? []);

    // POSITIVE LEG — the instrument sees demand.
    assert(
      demandAfterStart.has(lobbyId),
      `instrument blind: lobby root ${lobbyId} absent from published demand ` +
        `${JSON.stringify([...demandAfterStart])}`,
    );

    lobby.key("openRoom").send({});
    await runtime.settled();

    // The deferred navigate root really ran (otherwise every leg below
    // measures a navigation that never happened).
    assertEquals(navigations.length, 1);

    const started = startedRootIds(runtime);
    const demanded = new Set(demandCalls.flatMap((call) => call.pieces));
    const startedButNeverDemanded = [...started].filter((id) =>
      !demanded.has(id)
    );
    // The deferred navigate result root is the remaining started root: not the
    // lobby, not the navigate target. Named by elimination so the probe never
    // hardcodes a minted entity id.
    const deferredNavigateRoots = [...started].filter((id) =>
      id !== lobbyId && id !== navigations[0]
    );

    console.log(
      "[navigate-demand-probe]",
      JSON.stringify({
        seam,
        demandPublications: demandCalls.length,
        lastDemandSet: demandCalls.at(-1)?.pieces.length ?? 0,
        startedRoots: started.size,
        demandedEver: demanded.size,
        startedButNeverDemanded: startedButNeverDemanded.length,
        navigatedTarget: navigations[0],
        navigatedTargetDemanded: demanded.has(navigations[0]),
        deferredNavigateRootDemanded: deferredNavigateRoots.length > 0 &&
          deferredNavigateRoots.every((id) => demanded.has(id)),
        lobbyId,
        started: [...started],
        demanded: [...demanded],
      }),
    );

    // The navigation adds exactly two live roots: the deferred result root and
    // its nested target child.
    assertEquals(started.size, 3);
    assertEquals(deferredNavigateRoots.length, 1);

    // THE FIX (§8b) — the commit-gated deferred root reaches the demand wire
    // even though no `start()` call ever touches it. Without this the piece
    // that owns the `navigateTo` action is absent from every lane's demand
    // slice, and `candidateLaneKeys` returns [] at session rank — the only
    // rank `navigateTo` is admitted at.
    assertEquals(
      deferredNavigateRoots.filter((id) => !demanded.has(id)),
      [],
      "the commit-gated deferred navigate root must publish execution demand",
    );
    assertEquals(demanded.size, 2);
    assertEquals(demandCalls.length, 2);
    // Growth publishes the whole snapshot, so the last one carries both.
    assertEquals(new Set(demandCalls.at(-1)?.pieces).size, 2);

    // THE BOUNDARY — the nested navigate target is reached through
    // `startWithTx`, which §8b deliberately excludes: it is also the child
    // path, so publishing there would put every nested piece on the wire. The
    // target gets its own demand from the shell's `start()` once the
    // navigation lands.
    assertEquals(demanded.has(navigations[0]), false);
    assertEquals(startedButNeverDemanded, [navigations[0]]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

Deno.test(
  "demand covers a returned navigate's deferred root, not its child",
  () => probeDeferredNavigateDemand("startAfterSuccessfulCommit", true),
);

Deno.test(
  "demand covers a performed navigate's deferred root, not its child",
  () => probeDeferredNavigateDemand("runPatternAfterSuccessfulCommit", false),
);
