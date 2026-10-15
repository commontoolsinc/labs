/**
 * Several members of one FabriChat group room sending at the same moment, each
 * from a runtime of their own. Every message is kept, and the sends do not
 * collide: a send writes its own message, its own activity entry, its own
 * request memo, and its own recorded times, each a document of its own, and
 * joins them to the room's shared lists by mergeable additions. A time taken
 * from the clock starts at a place in the clock's tick that its sender's
 * principal chooses, so two senders in one second don't claim the same times.
 * So no send reads a document another member's send writes.
 *
 * The outcome alone cannot tell the two apart. A send that reads a list every
 * send writes, or a counter every send advances, still converges at a small
 * size, by conflicting and retrying; at a room's real size the retries run out
 * and messages are lost. So the test asks, as well, what each refused send was
 * refused over, and holds it to none of the room's shared records. The
 * runtime's own read of the room's whole argument document is the one stale
 * read it leaves out, as the comment where it does so says.
 *
 * Each member is a harness session with a Home stand-in, the
 * `fabrichat-add-offer` fixture, which holds a profile and a FabriChat manager
 * the room's `#profile` and `#chatManager` wishes resolve to.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

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

const MEMBERS = 4;
const MESSAGES = 4;

describe("fabrichat: members sending at once", () => {
  let harness: MultiRuntimeHarness;
  let members: MultiRuntimeSession[];

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: Array.from(
        { length: MEMBERS },
        (_, index) => `member-${index + 1}`,
      ),
      aclMode: "enforce",
      // Records each refused commit, which is what the burst's check reads.
      recordRejections: true,
    });
    members = harness.sessions;
    // Every member but the first, whose stand-in is the harness's piece, makes
    // a stand-in of their own, then a profile, and links their home space's
    // root to the stand-in.
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
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("keeps every message and refuses no send over another member's records", async () => {
    const [starter] = members;
    await starter.send("createGroup", {
      requestId: "burst-room",
      title: "Burst",
      members: members.slice(1).map((member) => member.identity.did()),
    }, START_ACTION);
    await harness.settle();
    expect(await starter.read(["requests", "burst-room", "status"])).toBe(
      "done",
    );
    const room = await starter.link([
      "requests",
      "burst-room",
      "entry",
      "room",
    ]);

    // Each member writes one message first, in turn, which joins them and
    // starts the room in their runtime, so the burst measures sends into a
    // room every member already holds.
    for (const [index, member] of members.entries()) {
      await member.send(
        "sendMessage",
        { requestId: "join", target: { value: `Member ${index + 1} joins.` } },
        SEND_ACTION,
        { piece: room },
      );
      await harness.settle();
    }
    await Promise.all(members.map((member) => member.clearRejections()));

    await Promise.all(
      members.flatMap((member, index) =>
        Array.from({ length: MESSAGES }, (_, message) =>
          member.send(
            "sendMessage",
            {
              requestId: `burst-${message}`,
              target: { value: `Message ${message + 1} from ${index + 1}.` },
            },
            SEND_ACTION,
            { piece: room, idle: false },
          ))
      ),
    );
    await Promise.all(members.map(async (member) => {
      await member.idle();
      await member.awaitEventConsequences();
    }));
    await harness.settle();

    // Every send refused over a stale read, by the documents it was stale
    // on. A send's commit also carries a read of the room's whole argument
    // document, which holds the room's lists and so changes with every
    // other member's addition to them. The room's handlers ask for no such
    // read: it is the runtime's, and is left out here, by what the document
    // holds. Any other stale document is one the room shares between sends.
    const holdsLists = new Map<string, boolean>();
    const isRoomArgument = async (id: string): Promise<boolean> => {
      if (!holdsLists.has(id)) {
        const held = await starter.rawRead({
          id,
          space: room.space,
          path: ["value"],
        });
        const value = held.value as Record<string, unknown> | undefined;
        holdsLists.set(
          id,
          Array.isArray(value?.messages) && Array.isArray(value?.activity),
        );
      }
      return holdsLists.get(id)!;
    };
    const refused: string[] = [];
    for (const member of members) {
      for (const rejection of await member.rejections()) {
        if (!rejection.writes.some((id) => id.startsWith("of:"))) continue;
        for (const [, id] of rejection.message.matchAll(/read: (of:\S+)/g)) {
          const reads = rejection.reads.filter((read) => read.startsWith(id));
          if (
            await isRoomArgument(id) &&
            reads.every((read) => read === `${id}/value`)
          ) {
            continue;
          }
          refused.push(
            `  ${member.label}: stale on ${id}, reading ${reads.join(", ")}`,
          );
        }
      }
    }

    const expected = [
      "join",
      ...Array.from({ length: MESSAGES }, (_, message) => `burst-${message}`),
    ];
    for (const member of members) {
      const requests = await member.read(["messageRequests"], {
        piece: room,
      }) as Record<string, { status?: string }>;
      expect(
        expected.map((id) => requests[id]?.status),
        `${member.label}'s sends`,
      ).toEqual(expected.map(() => "done"));
    }
    for (const member of members) {
      expect(
        await member.read(["messages", "count"], { piece: room }),
        `the messages ${member.label}'s runtime holds`,
      ).toBe(MEMBERS * (1 + MESSAGES));
    }
    expect(
      refused,
      "sends refused over a document another member's send wrote:\n" +
        refused.join("\n"),
    ).toEqual([]);
  });
});
