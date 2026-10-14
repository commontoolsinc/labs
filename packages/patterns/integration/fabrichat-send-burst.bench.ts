/**
 * How long a FabriChat room full of people writing at once takes to agree.
 *
 * Twelve members, each in a runtime of their own with a profile of their own,
 * each send five messages into one group room, every one of the sixty sent
 * before any of them settles, and the measurement runs until every member's
 * runtime holds every message. It is the FabriChat counterpart of
 * `lunch-poll-vote-burst.bench.ts`, and differs from it in what the writes
 * share. A lunch-poll vote is a keyed write that collides with nothing. A
 * FabriChat message is a keyed write too, but the same send appends to the
 * room's recent activity, which reads the activity list and the counters
 * record every send writes, and claims its recorded time from the times the
 * room has used. Two members sending at once therefore collide, and the loser
 * rolls back and runs again. How long that takes, and how much is thrown away
 * on the way, is what this measures.
 *
 * Each iteration writes into a room of its own. A send adds a message, so a
 * burst into one room would leave the next iteration a room sixty messages
 * larger, and every iteration would measure a different room. So each
 * iteration's room is created outside the measurement, by the first member
 * from their manager, naming every other member, and each member writes one
 * message into it before the burst, which joins them to it and starts the room
 * in their runtime. The burst then lands in a room of twelve messages and
 * twelve participants, every iteration.
 *
 * Each member is a harness session with a Home stand-in, the
 * `fabrichat-add-offer` fixture, which holds a profile created as Home creates
 * one, in a space of its own, and a FabriChat manager the room's
 * `#chatManager` wish resolves to. The harness hosts its own storage server,
 * enforcing access, with a serving loop attached when server execution is
 * enabled.
 *
 * Rejected commits and rolled-back writes, counted over one burst no
 * measurement covers, go to stderr and so into the run's `diagnostics.log`.
 *
 * `CF_FABRICHAT_BURST_MEMBERS` and `CF_FABRICHAT_BURST_MESSAGES` (each
 * member's messages per burst) resize it for a local run. The size names the
 * series, so changing it starts a new line rather than continuing this one; CI
 * leaves both unset.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { sizeFromEnv } from "./fabrichat-room-bench-support.ts";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const GROUP = "fabrichat";
const ROOT_PATH = join(import.meta.dirname!, "..");
const PROGRAM_PATH = join(
  ROOT_PATH,
  "integration",
  "fixtures",
  "fabrichat-add-offer",
  "main.tsx",
);

// The reviewed actions a start and a send are admitted from, as
// `../fabrichat/schemas.tsx` names them.
const START_ACTION = { surface: "ChatStartSurface", action: "ChatStart" };
const SEND_ACTION = { surface: "ChatSendSurface", action: "ChatSend" };

const MEMBERS = sizeFromEnv("CF_FABRICHAT_BURST_MEMBERS", 12);
const MESSAGES = sizeFromEnv("CF_FABRICHAT_BURST_MESSAGES", 5);

/**
 * Measured bursts, plus one unmeasured warm-up. Each costs a room's creation
 * and twelve joins before it, so a run is bounded here rather than left to
 * `deno bench`'s time budget.
 */
const ITERATIONS = 5;
const WARMUP = 1;

const harness = await MultiRuntimeHarness.create({
  programPath: PROGRAM_PATH,
  rootPath: ROOT_PATH,
  sessions: Array.from(
    { length: MEMBERS },
    (_, index) => `fabrichat-send-burst-${index + 1}`,
  ),
  aclMode: "enforce",
});
const members = harness.sessions;
const [starter] = members;

// Every member but the first, whose stand-in is the harness's piece, makes a
// stand-in of their own. Each then creates a profile and links their home
// space's root to the stand-in, so that a room's `#profile` and `#chatManager`
// wishes resolve there.
for (const member of members.slice(1)) {
  await member.client().call("createPiece", {
    programPath: PROGRAM_PATH,
    rootPath: ROOT_PATH,
  });
}
for (const [index, member] of members.entries()) {
  await member.send("createProfile", { name: `Member ${index + 1}` });
  await harness.settle();
  await member.client().call("linkHomeRoot", {});
  await harness.settle();
}

/** A room created for one burst. */
type Room = Awaited<ReturnType<MultiRuntimeSession["link"]>>;

/**
 * Creates a room from the starter's manager naming every other member, and
 * has each member write one message into it, in turn, which joins them and
 * starts the room in their runtime.
 */
async function openRoom(round: number): Promise<Room> {
  const requestId = `burst-room-${round}`;
  await starter.send("createGroup", {
    requestId,
    title: `Burst ${round}`,
    members: members.slice(1).map((member) => member.identity.did()),
  }, START_ACTION);
  await harness.settle();
  expect(await starter.read(["requests", requestId, "status"])).toBe("done");
  const room = await starter.link(["requests", requestId, "entry", "room"]);
  for (const [index, member] of members.entries()) {
    await member.send(
      "sendMessage",
      {
        requestId: `join-${round}`,
        target: { value: `Member ${index + 1} joins.` },
      },
      SEND_ACTION,
      { piece: room },
    );
    await harness.settle();
  }
  await verify(room, round, 0);
  return room;
}

/** Fire every member's messages before any of them settles, then settle all. */
async function burst(room: Room, round: number): Promise<void> {
  await Promise.all(
    members.flatMap((member, index) =>
      Array.from(
        { length: MESSAGES },
        (_, message) =>
          member.send(
            "sendMessage",
            {
              requestId: `burst-${round}-${message}`,
              target: {
                value: `Burst ${round}, message ${message + 1} from ` +
                  `member ${index + 1}.`,
              },
            },
            SEND_ACTION,
            { piece: room, idle: false },
          ),
      )
    ),
  );
  // A measured burst ends only after its served consequences arrive. The
  // harness's budgeted settle can return while those consequences are pending.
  await Promise.all(members.map(async (member) => {
    await member.idle();
    await member.awaitEventConsequences();
  }));
  await harness.settle();
}

/**
 * Checks, outside the measured interval, that every member's runtime holds
 * the room's joins and `sent` messages from each member, and that the room
 * recorded each of the member's own requests as done.
 */
async function verify(room: Room, round: number, sent: number): Promise<void> {
  await Promise.all(members.map(async (member) => {
    expect(
      await member.read(["messages", "count"], { piece: room }),
      member.label,
    ).toBe(MEMBERS * (1 + sent));
    const requests = await member.read(["messageRequests"], {
      piece: room,
    }) as Record<string, { status?: string }>;
    const expected = [
      `join-${round}`,
      ...Array.from({ length: sent }, (_, i) => `burst-${round}-${i}`),
    ];
    expect(
      expected.map((id) => requests[id]?.status),
      member.label,
    ).toEqual(expected.map(() => "done"));
  }));
}

/**
 * Rejected commits and rolled-back optimistic writes across every member so
 * far, and how many members' counters were there to read: a missing counter
 * reads as zero, the same number a burst without conflict reports, so the two
 * are told apart.
 */
async function reverts() {
  const each = await Promise.all(members.map(async (member) => {
    const storage = (await member.loggerCounts())["storage.v2"];
    return {
      conflicts: storage?.["commit-conflict"]?.total ?? 0,
      reverts: storage?.["commit-revert"]?.total ?? 0,
      counted: storage !== undefined,
    };
  }));
  return each.reduce((total, one) => ({
    conflicts: total.conflicts + one.conflicts,
    reverts: total.reverts + one.reverts,
    counting: total.counting + (one.counted ? 1 : 0),
  }), { conflicts: 0, reverts: 0, counting: 0 });
}

// Contention accounting, over one burst that no measurement covers.
{
  const room = await openRoom(0);
  const before = await reverts();
  await burst(room, 0);
  const after = await reverts();
  await verify(room, 0, MESSAGES);
  console.error(
    `[fabrichat send burst] ${MEMBERS} members x ${MESSAGES} messages = ` +
      `${MEMBERS * MESSAGES} messages per burst; one burst cost ` +
      `${after.conflicts - before.conflicts} rejected commit(s) and ` +
      `${after.reverts - before.reverts} rolled-back write(s), counted over ` +
      `${after.counting}/${MEMBERS} sessions`,
  );
}

// `Deno.bench` has no hook for "the file's benchmarks are done", so the
// workers are released at process exit instead, where the listener runs
// synchronously and `terminate()` is the form that fits.
globalThis.addEventListener("unload", () => harness.terminate());

let round = 1;

Deno.bench({
  name: `send burst ${MEMBERS}x${MESSAGES}`,
  group: GROUP,
  n: ITERATIONS,
  warmup: WARMUP,
  async fn(b) {
    const current = round++;
    const room = await openRoom(current);
    b.start();
    await burst(room, current);
    b.end();
    await verify(room, current, MESSAGES);
  },
});
