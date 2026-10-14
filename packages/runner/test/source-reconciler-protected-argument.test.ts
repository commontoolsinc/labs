/**
 * Drives a release of a `system:` pattern through the reconciler onto a piece
 * whose argument document holds fields only a named writer may change, each
 * holding what that writer put there. The reconciler sets the release up with
 * no argument, so the setup stages the stored document again, those fields
 * among them, and the release commits only where that staging leaves them as
 * they were.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";

import { markRendererTrustedEvent } from "../src/cfc/ui-contract.ts";
import {
  type Cell,
  getPatternIdentityRef,
  getPieceReconciliation,
  type PieceReconciliation,
  resolveEntryIdentity,
  Runtime,
  type RuntimeProgram,
  systemPatternSource,
} from "../src/index.ts";
import { runtimePresets } from "../src/runtime-presets.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const origin = systemPatternSource("system/guarded-room.tsx");
const route = "/api/patterns/system/guarded-room.tsx";

// `title` is written by `retitle` alone; `note` is guarded by nothing.
const WRITER_SOURCE = `/// <cts-enable />
import {
  Default,
  handler,
  pattern,
  Stream,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

const retitle = handler<{ text: string }, { title: Writable<{ text: string }> }>(
  ({ text }, { title }) => {
    title.set({ text });
  },
);

interface Input {
  title?: Default<
    WriteAuthorizedBy<{ text: string }, typeof retitle>,
    { text: "" }
  >;
  note?: Default<string, "">;
}

interface Output {
  title: { text: string };
  note: string;
  retitle: Stream<{ text: string }>;
}

export default pattern<Input, Output>(({ title, note }) => ({
  title,
  note,
  retitle: retitle({ title }),
}));
`;

// `about` is written by `describeRoom` alone, from its surface's trusted
// event, and labeled with its author; `badge` is written from its surface's
// trusted event by whatever handler receives one.
const CONTRACT_SOURCE = `/// <cts-enable />
import {
  type AuthoredByCurrentUser,
  Default,
  handler,
  pattern,
  Stream,
  type TrustedActionUiContract,
  type TrustedActionWrite,
  Writable,
} from "commonfabric";

const describeRoom = handler<
  { title: string },
  { about: Writable<{ title: string } | undefined> }
>(({ title }, { about }) => {
  about.set({ title });
});

const pin = handler<{ text: string }, { badge: Writable<{ text: string }> }>(
  ({ text }, { badge }) => {
    badge.set({ text });
  },
);

interface Input {
  about?: AuthoredByCurrentUser<
    TrustedActionWrite<
      { title: string },
      typeof describeRoom,
      "Describe",
      "GuardedRoom"
    >
  >;
  badge?: Default<
    TrustedActionUiContract<{ text: string }, "Pin", "GuardedRoom">,
    { text: "" }
  >;
}

interface Output {
  about?: { title: string };
  badge: { text: string };
  describeRoom: Stream<{ title: string }>;
  pin: Stream<{ text: string }>;
}

export default pattern<Input, Output>(({ about, badge }) => ({
  about,
  badge,
  describeRoom: describeRoom({ about }),
  pin: pin({ badge }),
}));
`;

/** What a test reads off a room. */
type Room = Record<string, unknown>;

/** What `reconcileRelease()` hands its probe. */
interface Released {
  /** What the reconciler returned. */
  outcome: string;

  /** The room, read after the reconciliation. */
  room: Cell<Room>;

  /** The reconciliation the room records. */
  recorded: PieceReconciliation | undefined;

  /** The identity of the source the room was made from. */
  previousIdentity: string;

  /** The identity of the release. */
  currentIdentity: string;
}

/** Sends `event` to the piece's `stream`, and waits for what it wrote. */
async function send(
  runtime: Runtime,
  room: Cell<Room>,
  stream: string,
  event: unknown,
): Promise<void> {
  (room.key(stream) as unknown as { send: (e: unknown) => void }).send(event);
  await runtime.idle();
  await room.pull();
  await runtime.idle();
}

/**
 * `fields` as an event from the room's own surface for `action`, which a
 * field that surface's UI contract guards needs: the renderer-trusted mark
 * and the surface's provenance.
 */
function trustedEvent<T extends object>(action: string, fields: T): T {
  const event = {
    ...fields,
    provenance: {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: "GuardedRoom",
        eventIntegrity: ["GuardedRoom"],
        uiContractDataset: { uiAction: action },
      },
    },
  };
  markRendererTrustedEvent(event);
  return event;
}

/**
 * Creates a room from `previous`, served as the `system:` origin's source,
 * and lets `prime` write its guarded fields. Then serves `current` instead,
 * reconciles the room, and hands what came of it to `probe`.
 */
async function reconcileRelease(
  name: string,
  previous: string,
  current: string,
  prime: (runtime: Runtime, room: Cell<Room>) => Promise<void>,
  probe: (released: Released) => void,
): Promise<void> {
  const signer = await Identity.fromPassphrase(`guarded argument ${name}`);
  const previousIdentity = await resolveEntryIdentity(
    route,
    () => Promise.resolve(previous),
  );
  const currentIdentity = await resolveEntryIdentity(
    route,
    () => Promise.resolve(current),
  );
  let served = { contents: previous, identity: previousIdentity };
  const runtime = new Runtime(runtimePresets.unitTest({
    apiUrl: new URL("https://room.test"),
    storageManager: StorageManager.emulate({ as: signer }),
    fetch: (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname !== route) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      return Promise.resolve(
        new Response(
          url.searchParams.has("identity") ? served.identity : served.contents,
        ),
      );
    },
  }));
  try {
    const program: RuntimeProgram = {
      main: route,
      files: [{ name: route, contents: previous }],
    };
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(program, {
      space: signer.did(),
      tx,
    });
    const room = runtime.getCell<Room>(signer.did(), name);
    runtime.runner.run(tx, pattern, {}, room, { sourceOrigin: origin });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await room.pull();
    await runtime.idle();
    await prime(runtime, room);
    expect(getPatternIdentityRef(room)?.identity).toBe(previousIdentity);

    served = { contents: current, identity: currentIdentity };
    const outcome = await runtime.sourceReconciler.reconcile(room);
    await runtime.runner.idlePointerMaintenance();
    await room.pull();
    probe({
      outcome,
      room,
      recorded: getPieceReconciliation(room),
      previousIdentity,
      currentIdentity,
    });
  } finally {
    await runtime.sourceReconciler.idle();
    await runtime.patternManager.flushCompileCacheWrites();
    await runtime.dispose();
  }
}

/** `source` one byte apart, which gives every handler in it a new identity. */
const releaseBehind = (source: string): string =>
  `${source}\n// a release behind\n`;

describe("source-reconciler-protected-argument", () => {
  describe("a field only its handler may write", () => {
    const prime = async (runtime: Runtime, room: Cell<Room>) => {
      await send(runtime, room, "retitle", { text: "lunch" });
      expect(room.get().title).toEqual({ text: "lunch" });
    };

    it("adopts a release that leaves the field as it is, and keeps what it holds", async () => {
      await reconcileRelease(
        "writer-release",
        releaseBehind(WRITER_SOURCE),
        WRITER_SOURCE,
        prime,
        ({ outcome, room, currentIdentity }) => {
          expect(outcome).toBe("updated");
          expect(getPatternIdentityRef(room)?.identity).toBe(currentIdentity);
          expect(room.get().title).toEqual({ text: "lunch" });
        },
      );
    });

    it("refuses a release whose setup would change the field, records why, and keeps the field as it was", async () => {
      // The release gives the field's record a member with a default, which
      // the setup fills into what the field holds: a write there only
      // `retitle` may make.
      const current = WRITER_SOURCE.replace(
        "WriteAuthorizedBy<{ text: string }, typeof retitle>",
        'WriteAuthorizedBy<{ text: string; color?: Default<string, "red"> }, typeof retitle>',
      );
      expect(current).not.toBe(WRITER_SOURCE);
      await reconcileRelease(
        "writer-changing-release",
        WRITER_SOURCE,
        current,
        prime,
        ({ outcome, room, recorded, previousIdentity }) => {
          expect(outcome).toBe("unavailable");
          expect(recorded?.outcome).toBe("unreachable");
          expect(recorded?.detail).toContain(
            "writeAuthorizedBy requires a trusted verified binding identity " +
              "at /title",
          );
          expect(getPatternIdentityRef(room)?.identity).toBe(previousIdentity);
          expect(room.get().title).toEqual({ text: "lunch" });
        },
      );
    });
  });

  describe("fields a UI contract guards", () => {
    const prime = async (runtime: Runtime, room: Cell<Room>) => {
      await send(
        runtime,
        room,
        "describeRoom",
        trustedEvent("Describe", { title: "lunch" }),
      );
      await send(runtime, room, "pin", trustedEvent("Pin", { text: "hi" }));
      expect(room.get().about).toEqual({ title: "lunch" });
      expect(room.get().badge).toEqual({ text: "hi" });
    };

    it("adopts a release that leaves the fields as they are, and keeps what they hold", async () => {
      await reconcileRelease(
        "contract-release",
        releaseBehind(CONTRACT_SOURCE),
        CONTRACT_SOURCE,
        prime,
        ({ outcome, room, currentIdentity }) => {
          expect(outcome).toBe("updated");
          expect(getPatternIdentityRef(room)?.identity).toBe(currentIdentity);
          expect(room.get().about).toEqual({ title: "lunch" });
          expect(room.get().badge).toEqual({ text: "hi" });
        },
      );
    });

    it("refuses a release whose setup would change a field, records the missing trusted event, and keeps the field as it was", async () => {
      // As for the writer's field above: the release fills a default into
      // what `badge` holds, which only an event from its surface may write.
      const current = CONTRACT_SOURCE.replace(
        'TrustedActionUiContract<{ text: string }, "Pin", "GuardedRoom">',
        'TrustedActionUiContract<{ text: string; color?: Default<string, "red"> }, "Pin", "GuardedRoom">',
      );
      expect(current).not.toBe(CONTRACT_SOURCE);
      await reconcileRelease(
        "contract-changing-release",
        CONTRACT_SOURCE,
        current,
        prime,
        ({ outcome, room, recorded, previousIdentity }) => {
          expect(outcome).toBe("unavailable");
          expect(recorded?.outcome).toBe("unreachable");
          expect(recorded?.detail).toContain(
            "missing trusted-event policy input for",
          );
          expect(recorded?.detail).toContain("at /badge");
          expect(getPatternIdentityRef(room)?.identity).toBe(previousIdentity);
          expect(room.get().badge).toEqual({ text: "hi" });
        },
      );
    });
  });
});
