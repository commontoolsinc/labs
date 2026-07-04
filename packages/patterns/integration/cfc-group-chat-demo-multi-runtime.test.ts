/**
 * Multi-runtime tests for the CFC group chat demo.
 *
 * Each test opens the same piece in several runtimes (Alice, Bob — distinct
 * identities — plus a second session for Alice) backed by one shared
 * in-memory storage server. This exercises what neither the single-runtime
 * pattern test nor the single-page browser test can: PerUser/PerSession
 * isolation between concurrently-active users, and live propagation of
 * PerSpace state between them.
 *
 * No toolshed or browser required.
 */

import { assert, assertEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";
import type {
  ChatProfile,
  ChatRoom,
  PlainChatMessage,
} from "../cfc-group-chat-demo/logic.ts";

// Trusted surface/action names from cfc-group-chat-demo/trusted.tsx (inlined
// so the test does not compile the pattern module into the test process).
const PROFILE_SURFACE = "TrustedGroupChatProfileSurface";
const SAVE_PROFILE_ACTION = "TrustedGroupChatSaveProfile";
const SEND_SURFACE = "TrustedGroupChatSendSurface";
const SEND_ACTION = "TrustedGroupChatSendMessage";
const ADMIN_SURFACE = "TrustedGroupChatAdminSurface";
const SET_ADMIN_ACTION = "TrustedGroupChatSetAdmin";
const ROOM_SURFACE = "TrustedGroupChatRoomSurface";
const ADD_ROOM_ACTION = "TrustedGroupChatAddRoom";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "..",
  "cfc-group-chat-demo",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

type ResolvedProfile = Pick<ChatProfile, "name">;
type ResolvedMessage = PlainChatMessage<ResolvedProfile>;
type ResolvedRoom = Pick<ChatRoom<ResolvedMessage>, "name">;

interface ResolvedProfileEntry {
  profile?: ResolvedProfile;
}

async function createGroupChatHarness(): Promise<MultiRuntimeHarness> {
  const alice = await Identity.fromPassphrase("group-chat alice", {
    implementation: "noble",
  });
  const apiUrl = Deno.env.get("MULTI_RUNTIME_API_URL");
  return await MultiRuntimeHarness.create({
    programPath: PROGRAM_PATH,
    rootPath: ROOT_PATH,
    ...(apiUrl ? { apiUrl: new URL(apiUrl) } : {}),
    sessions: [
      { label: "alice", identity: alice },
      { label: "bob" },
      // Same user as alice, separate runtime session (≈ second browser tab).
      { label: "alice-tab2", identity: alice },
    ],
  });
}

async function saveProfile(
  session: MultiRuntimeSession,
  name: string,
): Promise<void> {
  await session.send("setProfileDraft", name);
  await session.send("saveProfile", {}, {
    surface: PROFILE_SURFACE,
    action: SAVE_PROFILE_ACTION,
  });
}

async function sendMessage(
  session: MultiRuntimeSession,
  body: string,
): Promise<void> {
  await session.send("setMessageDraft", body);
  await session.send("sendTrustedMessage", {}, {
    surface: SEND_SURFACE,
    action: SEND_ACTION,
  });
}

async function addRoom(
  session: MultiRuntimeSession,
  name: string,
): Promise<void> {
  await session.send("setRoomDraft", name);
  await session.send("addTrustedRoom", {}, {
    surface: ROOM_SURFACE,
    action: ADD_ROOM_ACTION,
  });
}

async function messages(
  session: MultiRuntimeSession,
): Promise<ResolvedMessage[]> {
  const value = await session.read(["messages"]);
  if (value === undefined || value === null) return [];
  assert(Array.isArray(value), "messages resolved to a non-array value");
  return value as ResolvedMessage[];
}

// `rooms` defaults to `{}`, so reading the path ["rooms", "list"] would throw
// before the first room is added; read the parent and pluck the list instead.
async function rooms(session: MultiRuntimeSession): Promise<ResolvedRoom[]> {
  const value = (await session.read(["rooms"])) as
    | { list?: ResolvedRoom[] }
    | undefined;
  return value?.list ?? [];
}

describe("cfc group chat demo across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let alice: MultiRuntimeSession;
  let bob: MultiRuntimeSession;
  let aliceTab2: MultiRuntimeSession;

  beforeAll(async () => {
    harness = await createGroupChatHarness();
    alice = harness.session("alice");
    bob = harness.session("bob");
    aliceTab2 = harness.session("alice-tab2");
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("shares PerSpace messages between users (harness sanity)", async () => {
    await saveProfile(alice, "Alice");
    await harness.waitFor(
      "alice sees her own profile name",
      async () => (await alice.read(["currentProfileName"])) === "Alice",
    );

    await sendMessage(alice, "Hello from Alice");
    await harness.waitFor(
      "bob receives alice's message",
      async () =>
        (await messages(bob)).some((m) => m?.body === "Hello from Alice"),
    );
  });

  it("does not leak the profile name draft to another user", async () => {
    await alice.send("setProfileDraft", "Alice is typing");
    await harness.settle();

    const bobDraft = await bob.read(["profileDraft"]);
    assert(
      bobDraft === "" || bobDraft === undefined,
      `PerUser profileDraft leaked across users: bob sees ${
        JSON.stringify(bobDraft)
      }`,
    );

    // PerUser state SHOULD follow the same user into another session.
    await harness.waitFor(
      "alice's second session sees her own draft",
      async () =>
        (await aliceTab2.read(["profileDraft"])) === "Alice is typing",
    );
  });

  it("keeps PerSession drafts isolated between sessions of one user", async () => {
    await alice.send("setHostMessageDraft", "tab-local host draft");
    await harness.settle();

    const tab2Draft = await aliceTab2.read(["hostMessageDraft"]);
    assert(
      tab2Draft === "" || tab2Draft === undefined,
      `PerSession hostMessageDraft leaked across sessions: tab2 sees ${
        JSON.stringify(tab2Draft)
      }`,
    );
    const bobDraft = await bob.read(["hostMessageDraft"]);
    assert(
      bobDraft === "" || bobDraft === undefined,
      `PerSession hostMessageDraft leaked across users: bob sees ${
        JSON.stringify(bobDraft)
      }`,
    );
  });

  it("keeps each user's saved profile their own", async () => {
    await saveProfile(bob, "Bob");
    await harness.waitFor(
      "bob sees his own profile name",
      async () => (await bob.read(["currentProfileName"])) === "Bob",
    );
    await harness.settle();

    // Bob saving must not clobber Alice's PerUser profile.
    assertEquals(
      await alice.read(["currentProfileName"]),
      "Alice",
      "alice's profile was clobbered by bob saving his",
    );
    assertEquals(
      await aliceTab2.read(["currentProfileName"]),
      "Alice",
      "alice's profile (second session) was clobbered by bob saving his",
    );
  });

  it("shows other users' actual profile names, not unnamed placeholders", async () => {
    await sendMessage(bob, "Hi, this is Bob");
    await harness.waitFor(
      "alice receives bob's message",
      async () =>
        (await messages(alice)).some((m) => m?.body === "Hi, this is Bob"),
    );

    const aliceView = (await messages(alice)).find(
      (m) => m?.body === "Hi, this is Bob",
    );
    assertEquals(
      aliceView?.authorName,
      "Bob",
      "message author snapshot name wrong in alice's runtime",
    );
    // The live profile behind the message must resolve for OTHER users too —
    // this is what the participants list and admin panel display.
    assertEquals(
      aliceView?.authorProfile?.name,
      "Bob",
      "bob's profile does not resolve to his name in alice's runtime",
    );

    // The shared profile registry must expose both names to everyone.
    const profilesFromAlice = ((await alice.read(["profiles"])) as
      | ResolvedProfileEntry[]
      | undefined) ??
      [];
    const namesFromAlice = profilesFromAlice
      .map((entry) => entry?.profile?.name)
      .toSorted();
    assertEquals(
      namesFromAlice,
      ["Alice", "Bob"],
      "alice cannot resolve all registered profile names",
    );
  });

  it("admin lockdown gates room creation but never message sending", async () => {
    // Alice turns off "everyone is admin" — she becomes the bootstrap admin.
    await alice.send("toggleEveryoneAdmin", { everyoneIsAdmin: false }, {
      surface: ADMIN_SURFACE,
      action: SET_ADMIN_ACTION,
    });
    await harness.waitFor(
      "alice is still admin after lockdown",
      async () => (await alice.read(["currentUserIsAdmin"])) === true,
    );
    await harness.waitFor(
      "bob is no longer admin after lockdown",
      async () => (await bob.read(["currentUserIsAdmin"])) === false,
    );

    // Posting messages is NOT admin-gated: both users must still be able
    // to send.
    await sendMessage(bob, "Bob posts after lockdown");
    await harness.waitFor(
      "bob's post-lockdown message arrives at alice",
      async () =>
        (await messages(alice)).some(
          (m) => m?.body === "Bob posts after lockdown",
        ),
    );
    await sendMessage(alice, "Alice posts after lockdown");
    await harness.waitFor(
      "alice's post-lockdown message arrives at bob",
      async () =>
        (await messages(bob)).some(
          (m) => m?.body === "Alice posts after lockdown",
        ),
    );

    // Room creation IS admin-gated: bob's attempt must be rejected…
    await addRoom(bob, "Bob's room");
    await harness.settle();
    // waitFor retries through transiently-unsynced reads; the room list must
    // settle as readable AND empty.
    await harness.waitFor(
      "alice's room list stays empty after bob's rejected add",
      async () => (await rooms(alice)).length === 0,
    );
    assertEquals(
      (await rooms(alice)).map((room) => room?.name),
      [],
      "non-admin bob was able to add a room",
    );

    // …while admin alice's succeeds.
    await addRoom(alice, "Ops");
    await harness.waitFor(
      "bob sees the room alice added",
      async () => (await rooms(bob)).some((room) => room?.name === "Ops"),
    );
  });

  it("admins can grant admin to another user by name", async () => {
    await alice.send("toggleParticipantAdmin", { name: "Bob" }, {
      surface: ADMIN_SURFACE,
      action: SET_ADMIN_ACTION,
    });
    await harness.waitFor(
      "bob becomes admin after alice grants it",
      async () => (await bob.read(["currentUserIsAdmin"])) === true,
    );

    await addRoom(bob, "Bob's room");
    await harness.waitFor(
      "bob can add a room once admin",
      async () =>
        (await rooms(alice)).some((room) => room?.name === "Bob's room"),
    );
  });
});
