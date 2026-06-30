/// <cts-enable />
/**
 * Multi-user pattern test for the CFC group chat demo.
 *
 * Unlike main.test.tsx (one runtime, two GroupChatDemo instances wired to
 * separate cells), this runs ONE shared instance across two worker-isolated
 * runtimes with distinct identities — so PerUser/PerSession scope
 * partitioning and cross-runtime propagation are actually exercised.
 *
 * Each participant's steps run in order; cross-user ordering happens only at
 * `{ label }` / `{ await }` markers. See the multi-user section of
 * docs/common/patterns/multi-user-patterns.md.
 */
import {
  action,
  computed,
  type Default,
  multiUserTest,
  pattern,
  type Writable,
} from "commonfabric";
import {
  messagesValue,
  profilesValue,
  TRUSTED_GROUP_CHAT_ADMIN_SURFACE,
  TRUSTED_GROUP_CHAT_PROFILE_SURFACE,
  TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION,
  TRUSTED_GROUP_CHAT_SEND_ACTION,
  TRUSTED_GROUP_CHAT_SEND_SURFACE,
  TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION,
} from "./trusted.tsx";
import { GroupChatDemo, type GroupChatDemoOutput } from "./main.tsx";

// Renderer-trusted gestures for the protected writes; the runner sends these
// with trusted DOM provenance — the headless equivalent of clicking the
// reviewed surface (see main.test.tsx).
const profileGesture = {
  surface: TRUSTED_GROUP_CHAT_PROFILE_SURFACE,
  action: TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION,
};
const sendGesture = {
  surface: TRUSTED_GROUP_CHAT_SEND_SURFACE,
  action: TRUSTED_GROUP_CHAT_SEND_ACTION,
};
const adminGesture = {
  surface: TRUSTED_GROUP_CHAT_ADMIN_SURFACE,
  action: TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION,
};

type GroupChatDemoInputArg = Parameters<typeof GroupChatDemo>[0];

interface Setup {
  chat: GroupChatDemoOutput;
}

export const setup = pattern(() => ({
  chat: GroupChatDemo({} as GroupChatDemoInputArg),
}));

const profileNames = (chat: GroupChatDemoOutput): string[] =>
  profilesValue(chat.profiles)
    .map((profile) => profile.get()?.name ?? "")
    .filter((name) => name.length > 0)
    .toSorted();

const messageBodies = (chat: GroupChatDemoOutput): string[] =>
  messagesValue(chat.messages).map((m) => m.body);

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const chat = setup.chat;
  const action_set_name = action(() => {
    chat.setProfileDraft.send("Alice");
  });
  const action_set_message = action(() => {
    chat.setMessageDraft.send("Hello from Alice");
  });

  const assert_named_alice = computed(() =>
    chat.currentProfileName === "Alice"
  );
  const assert_sees_both_profiles = computed(() =>
    profileNames(chat).join(",") === "Alice,Bob"
  );
  const assert_sees_bobs_message = computed(() =>
    messageBodies(chat).includes("Hi from Bob")
  );
  const assert_sees_bobs_lockdown_message = computed(() =>
    messageBodies(chat).includes("Bob posts after lockdown")
  );
  const assert_is_admin = computed(() => chat.currentUserIsAdmin === true);

  return {
    tests: [
      { action: action_set_name },
      { action: chat.saveProfile, trustedUi: profileGesture },
      { assertion: assert_named_alice },
      { label: "alice-saved" },
      { await: "bob-saved" },
      // Bob saving must not clobber Alice's PerUser profile, and the shared
      // registry must resolve BOTH names in Alice's runtime.
      { assertion: assert_named_alice },
      { assertion: assert_sees_both_profiles },
      { action: action_set_message },
      { action: chat.sendTrustedMessage, trustedUi: sendGesture },
      { label: "alice-posted" },
      { await: "bob-posted" },
      { assertion: assert_sees_bobs_message },
      // Admin lockdown: Alice becomes the bootstrap admin; posting stays
      // open for everyone (the original regression disabled it).
      {
        action: chat.toggleEveryoneAdmin,
        event: { everyoneIsAdmin: false },
        trustedUi: adminGesture,
      },
      { assertion: assert_is_admin },
      { label: "alice-locked-down" },
      { await: "bob-posted-after-lockdown" },
      { assertion: assert_sees_bobs_lockdown_message },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const chat = setup.chat;
  const action_set_name = action(() => {
    chat.setProfileDraft.send("Bob");
  });
  const action_set_message = action(() => {
    chat.setMessageDraft.send("Hi from Bob");
  });
  const action_set_lockdown_message = action(() => {
    chat.setMessageDraft.send("Bob posts after lockdown");
  });

  // PerUser draft: Alice's typing must never show up in Bob's runtime.
  const profileDraft: Writable<string | Default<"">> = chat.profileDraft;
  const assert_draft_empty = computed(() => (profileDraft.get() ?? "") === "");
  const assert_unnamed = computed(() =>
    chat.currentProfileName === "Name not set"
  );
  const assert_named_bob = computed(() => chat.currentProfileName === "Bob");
  const assert_sees_alice_profile = computed(() =>
    profileNames(chat).includes("Alice")
  );
  const assert_sees_alices_message = computed(() =>
    messageBodies(chat).includes("Hello from Alice")
  );
  const assert_not_admin = computed(() => chat.currentUserIsAdmin === false);

  return {
    tests: [
      { await: "alice-saved" },
      { assertion: assert_draft_empty },
      { assertion: assert_unnamed },
      { assertion: assert_sees_alice_profile },
      { action: action_set_name },
      { action: chat.saveProfile, trustedUi: profileGesture },
      { assertion: assert_named_bob },
      { label: "bob-saved" },
      { await: "alice-posted" },
      { assertion: assert_sees_alices_message },
      { action: action_set_message },
      { action: chat.sendTrustedMessage, trustedUi: sendGesture },
      { label: "bob-posted" },
      { await: "alice-locked-down" },
      { assertion: assert_not_admin },
      { action: action_set_lockdown_message },
      { action: chat.sendTrustedMessage, trustedUi: sendGesture },
      { label: "bob-posted-after-lockdown" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
