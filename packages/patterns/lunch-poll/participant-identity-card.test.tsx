import {
  action,
  computed,
  Default,
  equals,
  pattern,
  UI,
  Writable,
} from "commonfabric";
import ParticipantIdentityCard from "./participant-identity-card.tsx";
import {
  DEFAULT_PARTICIPANT_PROFILES,
  type LunchProfile,
  type ParticipantProfileDirectoryValue,
  type User,
} from "./main.tsx";
import {
  findNode,
  hasText,
  propsOf,
  readValue,
} from "../test/vnode-helpers.ts";

// Find a rendered node by a prop value. Walking the tree pulls the join
// surface's UI-only computeds (showManualEntry, hasProfile, joinHint), which no
// direct handler/output read reaches otherwise.
const findByProp = (
  root: unknown,
  prop: string,
  expected: unknown,
): unknown | undefined =>
  findNode(root, (node) => {
    const props = propsOf(node);
    return props !== undefined && readValue(props[prop]) === expected;
  });

export default pattern(() => {
  const users = new Writable<User[] | Default<[]>>([]);
  const myName = new Writable<string | Default<"">>("");
  const adminName = new Writable<string | Default<"">>("");
  const participantProfiles = Writable.of<ParticipantProfileDirectoryValue>(
    DEFAULT_PARTICIPANT_PROFILES,
  );
  const participantIdentity = ParticipantIdentityCard({
    users,
    myName,
    adminName,
    participantProfiles,
  });

  // The profile-backed path is injected explicitly so lane-2 tests exercise
  // the same live profile cell that the parent receives from `wish("#profile")`.
  const profileUsers = new Writable<User[] | Default<[]>>([]);
  const profileMyName = new Writable<string | Default<"">>("");
  const profileAdminName = new Writable<string | Default<"">>("");
  const profileDirectory = Writable.of<ParticipantProfileDirectoryValue>(
    DEFAULT_PARTICIPANT_PROFILES,
  );
  const aliceProfile = Writable.of<LunchProfile>({
    initialNameApplied: "Profile Alice",
    name: "Stale fallback",
    avatar: "alice.png",
    bio: "Lunch enthusiast",
  });
  const profileIdentity = ParticipantIdentityCard({
    users: profileUsers,
    myName: profileMyName,
    adminName: profileAdminName,
    participantProfiles: profileDirectory,
    profile: aliceProfile,
  });

  // Profile-first UI fires `joinAs.send({})` (no name) for the "Join as <name>"
  // button. With no profile resolved and no typed name, that must be a safe
  // no-op — never enrolling a blank participant.
  const action_join_empty = action(() => {
    participantIdentity.joinAs.send({});
  });

  const action_join_as_alex = action(() => {
    participantIdentity.joinAs.send({ name: "Alex" });
  });

  const action_join_with_profile = action(() => {
    profileIdentity.joinAs.send({});
  });

  const action_use_different_name = action(() => {
    const button = findByProp(
      profileIdentity[UI],
      "aria-label",
      "Use a different name",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const action_cancel_different_name = action(() => {
    const button = findByProp(
      profileIdentity[UI],
      "aria-label",
      "Back to profile join",
    );
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const action_update_canonical_profile = action(() => {
    aliceProfile.set({
      initialNameApplied: "Alice Updated",
      name: "Stale fallback",
      avatar: "alice-updated.png",
      bio: "Still a lunch enthusiast",
    });
  });

  const action_try_rejoin_as_alex_two = action(() => {
    participantIdentity.joinAs.send({ name: "Alex Two" });
  });

  const action_switch_to_blair = action(() => {
    users.push({
      name: "Blair",
      avatar: "",
      color: "#c2573a",
    });
    myName.set("Blair");
  });

  const action_claim_host_as_blair = action(() => {
    participantIdentity.claimHost.send({});
  });

  const assert_initial = computed(() =>
    users.get().length === 0 &&
    participantIdentity.me === "" &&
    participantIdentity.isJoined === false &&
    participantIdentity.isAdmin === false
  );

  // With no profile resolved and nobody joined, the join surface shows the
  // profile-setup branch: the wish's built-in [UI] slot plus the explicit
  // "Continue as guest" button. The typed-name input is NOT present — the
  // guest path never appears automatically (it needs the explicit toggle).
  // Walking the tree materializes showProfileSetup, hasProfile, and joinHint.
  const assert_guest_setup_renders = computed(() => {
    const ui = participantIdentity[UI];
    const guestButton = findByProp(ui, "id", "lp-guest-button");
    const input = findByProp(ui, "id", "lp-join-name");
    const setupSlot = findByProp(ui, "data-profile-setup", true);
    return guestButton !== undefined &&
      input === undefined &&
      setupSlot !== undefined &&
      hasText(ui, "First to join becomes the host.");
  });

  const assert_profile_first_renders = computed(() => {
    const ui = profileIdentity[UI];
    return hasText(ui, "Join as Profile Alice") &&
      findByProp(ui, "data-profile-identity", "canonical") !== undefined &&
      findByProp(ui, "aria-label", "Use a different name") !== undefined;
  });

  const assert_profile_manual_entry_renders = computed(() => {
    const ui = profileIdentity[UI];
    return findByProp(ui, "id", "lp-join-name") !== undefined &&
      findByProp(ui, "aria-label", "Back to profile join") !== undefined &&
      findByProp(ui, "data-profile-identity", "canonical") === undefined;
  });

  const assert_empty_send_noop = computed(() =>
    users.get().length === 0 &&
    participantIdentity.me === "" &&
    participantIdentity.isJoined === false
  );

  const assert_joined_as_alex = computed(() => {
    const currentUsers = users.get();
    return currentUsers.length === 1 &&
      currentUsers[0]?.name === "Alex" &&
      myName.get() === "Alex" &&
      adminName.get() === "Alex" &&
      participantProfiles.get().participants.length === 0 &&
      participantIdentity.me === "Alex" &&
      participantIdentity.isJoined === true &&
      participantIdentity.isAdmin === true;
  });

  const assert_joined_with_profile = computed(() => {
    const currentUsers = profileUsers.get();
    const links = profileDirectory.get().participants;
    return currentUsers.length === 1 &&
      currentUsers[0]?.name === "Profile Alice" &&
      currentUsers[0]?.avatar === "alice.png" &&
      profileMyName.get() === "Profile Alice" &&
      profileAdminName.get() === "Profile Alice" &&
      links.length === 1 &&
      links[0]?.name === "Profile Alice" &&
      equals(links[0]?.profile, aliceProfile) &&
      profileIdentity.isJoined === true &&
      profileIdentity.isAdmin === true;
  });

  const assert_profile_link_stays_live = computed(() => {
    const currentUsers = profileUsers.get();
    return currentUsers[0]?.name === "Profile Alice" &&
      currentUsers[0]?.avatar === "alice.png" &&
      profileIdentity.profileName === "Alice Updated";
  });

  const assert_rejoin_noop = computed(() => {
    const currentUsers = users.get();
    return currentUsers.length === 1 &&
      currentUsers[0]?.name === "Alex" &&
      myName.get() === "Alex";
  });

  const assert_blair_is_not_host = computed(() =>
    users.get().length === 2 &&
    participantIdentity.me === "Blair" &&
    adminName.get() === "Alex" &&
    participantIdentity.isJoined === true &&
    participantIdentity.isAdmin === false
  );

  const assert_blair_claimed_host = computed(() =>
    adminName.get() === "Blair" &&
    participantIdentity.me === "Blair" &&
    participantIdentity.isAdmin === true
  );

  return {
    tests: [
      { assertion: assert_initial },
      { assertion: assert_guest_setup_renders },
      { assertion: assert_profile_first_renders },
      { action: action_use_different_name },
      { assertion: assert_profile_manual_entry_renders },
      { action: action_cancel_different_name },
      { assertion: assert_profile_first_renders },
      { action: action_join_empty },
      { assertion: assert_empty_send_noop },
      { action: action_join_with_profile },
      { assertion: assert_joined_with_profile },
      { action: action_update_canonical_profile },
      { assertion: assert_profile_link_stays_live },
      { action: action_join_as_alex },
      { assertion: assert_joined_as_alex },
      { action: action_try_rejoin_as_alex_two },
      { assertion: assert_rejoin_noop },
      { action: action_switch_to_blair },
      { assertion: assert_blair_is_not_host },
      { action: action_claim_host_as_blair },
      { assertion: assert_blair_claimed_host },
    ],
    participantIdentity,
  };
});
