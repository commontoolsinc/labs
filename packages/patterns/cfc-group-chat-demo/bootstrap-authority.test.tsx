/**
 * CFC group chat — who may write the bootstrap admin role
 *
 * While the explicit roster is empty, `bootstrapAdmin` is the whole explicit
 * admin policy, so it names the one handler that may modify it. A handler the
 * role does not name cannot set it, before the first lockdown or after it,
 * and the first-admin bootstrap still works on a fresh registry.
 *
 * A refused write is reported as a CFC policy warning, which is why console
 * warnings are allowed.
 */
import {
  assert,
  type Cell,
  Default,
  handler,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import type { ChatProfile } from "./logic.ts";
import {
  type ChatAdminRegistryStoredValue,
  type ChatAdminRegistryValue,
  type EmptyMyProfileValue,
  type MyProfileCellValue,
  type SharedMessagesValue,
  type SharedProfilesValue,
  type SharedRoomsValue,
  TRUSTED_GROUP_CHAT_ADMIN_SURFACE,
  TRUSTED_GROUP_CHAT_PROFILE_SURFACE,
  TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION,
  TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION,
} from "./trusted.tsx";
import { GroupChatDemo } from "./main.tsx";

const profileGesture = {
  surface: TRUSTED_GROUP_CHAT_PROFILE_SURFACE,
  action: TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION,
};
const adminGesture = {
  surface: TRUSTED_GROUP_CHAT_ADMIN_SURFACE,
  action: TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION,
};

type GroupChatDemoInputArg = Parameters<typeof GroupChatDemo>[0];

const submitted = (text: string) => ({
  type: "click",
  target: { value: text },
});

/** The click that turns the everyone-is-admin fallback off. */
const lockdownClick = { type: "click", target: { name: "", value: "on" } };

/** A role as code that knows the registry's shape and none of its policy. */
interface PlainRole {
  subject: Cell<ChatProfile | undefined>;
  displayName: string;
}

/** What `plantBootstrapAdmin` is bound to. */
interface PlantState {
  registry: Writable<{ bootstrapAdmin?: PlainRole }>;
  profile: Cell<ChatProfile | undefined>;
  name: string;
}

/**
 * A handler the role does not name, setting the bootstrap role to a profile
 * of its choosing.
 */
const plantBootstrapAdmin = handler<void, PlantState>((
  _,
  { registry, profile, name },
) => {
  registry.key("bootstrapAdmin").set({ subject: profile, displayName: name });
});

const bootstrapName = (
  registry: Writable<ChatAdminRegistryValue>,
): string | undefined =>
  (registry.get() as ChatAdminRegistryStoredValue | undefined)?.bootstrapAdmin
    ?.displayName;

const emptyProfile = () =>
  Writable.of<MyProfileCellValue>({} as Default<EmptyMyProfileValue>);

/** A chat room's shared cells, with one participant per profile. */
const room = () => ({
  messages: Writable.of<SharedMessagesValue>([] as SharedMessagesValue),
  profiles: Writable.of<SharedProfilesValue>([] as SharedProfilesValue),
  rooms: Writable.of<SharedRoomsValue>({} as SharedRoomsValue),
  adminRegistry: Writable.of<ChatAdminRegistryValue>(
    {} as ChatAdminRegistryValue,
  ),
});

export default pattern(() => {
  // ============================================================
  // Subject 1: the first lockdown bootstraps Alice, and code the role does
  // not name cannot replace her
  // ============================================================

  const shared = room();
  const aliceProfile = emptyProfile();
  const malloryProfile = emptyProfile();
  const aliceChat = GroupChatDemo(
    { myProfile: aliceProfile, ...shared } as GroupChatDemoInputArg,
  );
  const malloryChat = GroupChatDemo(
    { myProfile: malloryProfile, ...shared } as GroupChatDemoInputArg,
  );
  // Typed by the registry's shape alone, so the write carries none of the
  // role's policy and only the stored contract can refuse it.
  const malloryPlantsSelf = plantBootstrapAdmin({
    registry: shared.adminRegistry as never,
    profile: malloryProfile.key("profile") as never,
    name: "Mallory",
  });

  const assert_alice_bootstrapped = assert(() =>
    bootstrapName(shared.adminRegistry) === "Alice" &&
    aliceChat.currentUserIsAdmin === true &&
    malloryChat.currentUserIsAdmin !== true
  );
  const assert_plant_after_bootstrap_refused = assert(() =>
    bootstrapName(shared.adminRegistry) === "Alice" &&
    aliceChat.currentUserIsAdmin === true &&
    malloryChat.currentUserIsAdmin !== true
  );

  // ============================================================
  // Subject 2: a role planted before the first lockdown is refused, so the
  // lockdown still names the person who made it
  // ============================================================

  const early = room();
  const earlyAliceProfile = emptyProfile();
  const earlyMalloryProfile = emptyProfile();
  const earlyAliceChat = GroupChatDemo(
    { myProfile: earlyAliceProfile, ...early } as GroupChatDemoInputArg,
  );
  const earlyMalloryChat = GroupChatDemo(
    { myProfile: earlyMalloryProfile, ...early } as GroupChatDemoInputArg,
  );
  const malloryPlantsEarly = plantBootstrapAdmin({
    registry: early.adminRegistry as never,
    profile: earlyMalloryProfile.key("profile") as never,
    name: "Mallory",
  });

  const assert_early_plant_refused = assert(() =>
    bootstrapName(early.adminRegistry) === undefined
  );
  const assert_lockdown_names_alice = assert(() =>
    bootstrapName(early.adminRegistry) === "Alice" &&
    earlyAliceChat.currentUserIsAdmin === true &&
    earlyMalloryChat.currentUserIsAdmin !== true
  );

  return {
    allowConsoleWarnings: true,
    [TESTS]: [
      // Subject 1
      {
        action: aliceChat.saveProfile,
        event: submitted("Alice"),
        trustedUi: profileGesture,
      },
      {
        action: malloryChat.saveProfile,
        event: submitted("Mallory"),
        trustedUi: profileGesture,
      },
      {
        action: aliceChat.toggleEveryoneAdmin,
        event: lockdownClick,
        trustedUi: adminGesture,
      },
      { assertion: assert_alice_bootstrapped },
      // Sent from the reviewed surface, so only the writer binding refuses it.
      { action: malloryPlantsSelf, trustedUi: adminGesture },
      { assertion: assert_plant_after_bootstrap_refused },

      // Subject 2
      {
        action: earlyAliceChat.saveProfile,
        event: submitted("Alice"),
        trustedUi: profileGesture,
      },
      {
        action: earlyMalloryChat.saveProfile,
        event: submitted("Mallory"),
        trustedUi: profileGesture,
      },
      { action: malloryPlantsEarly, trustedUi: adminGesture },
      { assertion: assert_early_plant_refused },
      {
        action: earlyAliceChat.toggleEveryoneAdmin,
        event: lockdownClick,
        trustedUi: adminGesture,
      },
      { assertion: assert_lockdown_names_alice },
    ],
  };
});
