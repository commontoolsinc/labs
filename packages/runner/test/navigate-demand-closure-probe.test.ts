/**
 * Wave-G gate-4 follow-on probe (navigate-to-server-side.md §8): does
 * execution demand grow to cover a commit-gated deferred navigate result
 * root, which no `start()` call ever reaches?
 *
 * The measurement is a counter, not an argument. It records every
 * `setExecutionDemand` publication the runtime makes while a
 * `group-chat-lobby.tsx:154`-shaped handler (`return navigateTo(Instance)`)
 * fires, and compares the published root set against the roots the runner
 * actually started (`runner.cancels`).
 *
 * The positive leg is load-bearing: the parent root MUST appear, or the
 * instrument cannot see demand at all and the negative leg is vacuous
 * (the wave-B lesson, passivity-arc-orchestration.md §6).
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

Deno.test(
  "demand does not grow to cover a commit-gated deferred navigate root",
  async () => {
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

      // packages/patterns/group-chat-lobby.tsx:154 in miniature.
      const Room = pattern(() => ({ title: "probe room" }));
      const openRoom = handler(
        { type: "object", properties: {} },
        { type: "object", properties: {} },
        () => navigateTo(Room({})),
      );
      const Lobby = pattern(() => ({ openRoom: openRoom({}) }));

      const setupTx = runtime.edit();
      const lobbyCell = runtime.getCell<{ openRoom: unknown }>(
        space,
        "navigate demand closure probe lobby",
        undefined,
        setupTx,
      );
      const lobby = runtime.run(setupTx, Lobby, {}, lobbyCell);
      await setupTx.commit();
      await lobby.pull();

      // The client's own start is the ONLY demand publication path
      // (runner.ts:1286, inside start()).
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

      // The deferred navigate root really ran (otherwise the negative leg
      // below measures a navigation that never happened).
      assertEquals(navigations.length, 1);

      const started = startedRootIds(runtime);
      const demanded = new Set(demandCalls.flatMap((call) => call.pieces));
      const startedButNeverDemanded = [...started].filter((id) =>
        !demanded.has(id)
      );

      console.log(
        "[navigate-demand-probe]",
        JSON.stringify({
          demandPublications: demandCalls.length,
          lastDemandSet: demandCalls.at(-1)?.pieces.length ?? 0,
          startedRoots: started.size,
          demandedEver: demanded.size,
          startedButNeverDemanded: startedButNeverDemanded.length,
          navigatedTarget: navigations[0],
          navigatedTargetDemanded: demanded.has(navigations[0]),
        }),
      );

      // NEGATIVE LEG — the navigation added live roots to the runner and
      // NONE of them reached the demand wire.
      assert(
        started.size > demanded.size,
        `expected more started roots than demanded roots; started=${started.size} ` +
          `demanded=${demanded.size}`,
      );
      assert(
        startedButNeverDemanded.length > 0,
        "expected at least one started-but-never-demanded root",
      );
      // The navigate TARGET piece — the thing the user lands on — is one of
      // them, so not even the target is demanded.
      assertEquals(demanded.has(navigations[0]), false);
      // Demand never grew past the one explicitly started root.
      assertEquals([...demanded].filter((id) => id !== lobbyId), []);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  },
);
