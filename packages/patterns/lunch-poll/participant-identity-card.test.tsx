import { action, computed, Default, pattern, UI, Writable } from "commonfabric";
import ParticipantIdentityCard, {
  joinAsParticipant,
} from "./participant-identity-card.tsx";
import type { User } from "./main.tsx";
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
  // Bind the handler to deliberately unmaterialized profile values. This is
  // the runtime shape that exposed the staging failure: an explicit event name
  // is usable, but unrelated asynchronous wish captures are still undefined.
  const unresolvedProfileNameSource = new Writable<string>();
  const unresolvedProfileAvatarSource = new Writable<string>();
  const unresolvedProfileName = computed(() =>
    unresolvedProfileNameSource.get()
  );
  const unresolvedProfileAvatar = computed(() =>
    unresolvedProfileAvatarSource.get()
  );
  const unresolvedUsers = new Writable<User[] | Default<[]>>([]);
  const unresolvedMyName = new Writable<string | Default<"">>("");
  const unresolvedAdminName = new Writable<string | Default<"">>("");
  const unresolvedJoinName = new Writable<string | Default<"">>("");
  const joinWithUnresolvedProfile = joinAsParticipant({
    users: unresolvedUsers,
    myName: unresolvedMyName,
    adminName: unresolvedAdminName,
    joinName: unresolvedJoinName,
    profileName: unresolvedProfileName,
    profileAvatar: unresolvedProfileAvatar,
  });

  // The profile-first path still supplies both resolved values to the same
  // handler; making those captures optional must not discard the avatar.
  const profileUsers = new Writable<User[] | Default<[]>>([]);
  const profileMyName = new Writable<string | Default<"">>("");
  const profileAdminName = new Writable<string | Default<"">>("");
  const profileJoinName = new Writable<string | Default<"">>("");
  const joinWithProfile = joinAsParticipant({
    users: profileUsers,
    myName: profileMyName,
    adminName: profileAdminName,
    joinName: profileJoinName,
    profileName: "Profile Pat",
    profileAvatar: "pat-avatar.png",
  });

  const users = new Writable<User[] | Default<[]>>([]);
  const myName = new Writable<string | Default<"">>("");
  const adminName = new Writable<string | Default<"">>("");
  const participantIdentity = ParticipantIdentityCard({
    users,
    myName,
    adminName,
  });

  const action_join_with_unresolved_profile_captures = action(() => {
    joinWithUnresolvedProfile.send({ name: "Fallback Host" });
  });

  const assert_joined_despite_unresolved_profile_captures = computed(() => {
    const currentUsers = unresolvedUsers.get();
    return currentUsers.length === 1 &&
      currentUsers[0]?.name === "Fallback Host" &&
      currentUsers[0]?.avatar === "" &&
      unresolvedMyName.get() === "Fallback Host" &&
      unresolvedAdminName.get() === "Fallback Host";
  });

  const action_join_with_resolved_profile = action(() => {
    joinWithProfile.send({});
  });

  const assert_profile_name_and_avatar_preserved = computed(() => {
    const currentUsers = profileUsers.get();
    return currentUsers.length === 1 &&
      currentUsers[0]?.name === "Profile Pat" &&
      currentUsers[0]?.avatar === "pat-avatar.png" &&
      profileMyName.get() === "Profile Pat" &&
      profileAdminName.get() === "Profile Pat";
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

  const action_try_rejoin_as_alex_two = action(() => {
    participantIdentity.joinAs.send({ name: "Alex Two" });
  });

  const action_switch_to_blair = action(() => {
    users.push({
      name: "Blair",
      avatar: "",
      color: "#c2573a",
      joinedAt: 1,
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
  // manual-name fallback: the text input and Join button render, the "First to
  // join becomes the host." hint shows, and neither profile-first control (the
  // "Use a different name" toggle nor the "Cancel" escape hatch) is present.
  // Walking the tree materializes showManualEntry, hasProfile, and joinHint.
  const assert_manual_fallback_renders = computed(() => {
    const ui = participantIdentity[UI];
    const input = findByProp(ui, "id", "lp-join-name");
    const joinButton = findByProp(ui, "id", "lp-join-button");
    const useDifferentName = findByProp(
      ui,
      "aria-label",
      "Use a different name",
    );
    const cancel = findByProp(ui, "aria-label", "Use my profile name instead");
    return input !== undefined &&
      joinButton !== undefined &&
      useDifferentName === undefined &&
      cancel === undefined &&
      hasText(ui, "First to join becomes the host.");
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
      participantIdentity.me === "Alex" &&
      participantIdentity.isJoined === true &&
      participantIdentity.isAdmin === true;
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
      { action: action_join_with_unresolved_profile_captures },
      { assertion: assert_joined_despite_unresolved_profile_captures },
      { action: action_join_with_resolved_profile },
      { assertion: assert_profile_name_and_avatar_preserved },
      { assertion: assert_initial },
      { assertion: assert_manual_fallback_renders },
      { action: action_join_empty },
      { assertion: assert_empty_send_noop },
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
