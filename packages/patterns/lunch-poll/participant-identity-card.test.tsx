import {
  action,
  assert,
  Default,
  equals,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import ParticipantIdentityCard from "./participant-identity-card.tsx";
import {
  DEFAULT_HOST,
  type HostValue,
  type LunchProfile,
  type User,
} from "./main.tsx";
import {
  findNode,
  hasText,
  propsOf,
  readValue,
} from "../test/vnode-helpers.ts";

// Find a rendered node by a prop value. Walking the tree pulls the join
// surface's UI-only computeds (hasProfile, joinHint), which no direct
// handler/output read reaches otherwise.
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
  // Lane 1 — no profile resolved: the card shows the create/pick surface and
  // offers no way in. Joining requires an identity, so there is no typed-name
  // fallback to collide with or spoof.
  const noProfileUsers = new Writable<User[] | Default<[]>>([]);
  const noProfileHost = Writable.of<HostValue>(DEFAULT_HOST);
  const noProfileCard = ParticipantIdentityCard({
    users: noProfileUsers,
    host: noProfileHost,
    profileName: "",
    profileAvatar: "",
  });

  // Lane 2 — two DIFFERENT people who share a display name. Under name-keyed
  // identity these collided; under cell identity they are simply two people.
  const users = new Writable<User[] | Default<[]>>([]);
  const host = Writable.of<HostValue>(DEFAULT_HOST);

  const alexProfile = Writable.of<LunchProfile>({
    name: "Alex",
    avatar: "alex.png",
  });
  const otherAlexProfile = Writable.of<LunchProfile>({ name: "Alex" });

  const alexName = new Writable<string | Default<"">>("Alex");
  const alexCard = ParticipantIdentityCard({
    users,
    host,
    profile: alexProfile,
    profileName: alexName,
    profileAvatar: "alex.png",
  });
  const otherAlexCard = ParticipantIdentityCard({
    users,
    host,
    profile: otherAlexProfile,
    profileName: "Alex",
    profileAvatar: "",
  });

  // === Actions ===

  const action_join_as_alex = action(() => {
    alexCard.joinAs.send({});
  });
  const action_join_again = action(() => {
    alexCard.joinAs.send({});
  });
  const action_join_as_other_alex = action(() => {
    otherAlexCard.joinAs.send({});
  });
  const action_other_alex_claims_host = action(() => {
    otherAlexCard.claimHost.send({});
  });
  const action_rename_alex = action(() => {
    alexName.set("Alexandra");
  });
  const action_join_with_no_profile = action(() => {
    noProfileCard.joinAs.send({});
  });

  // === Assertions ===

  const assert_setup_surface_without_profile = assert(() => {
    const ui = noProfileCard[UI];
    return findByProp(ui, "data-profile-setup", true) !== undefined &&
      findByProp(ui, "id", "lp-join-button") === undefined &&
      hasText(ui, "First to join becomes the host.");
  });

  // Joining needs an identity, so a viewer without one changes nothing.
  const assert_no_profile_cannot_join = assert(() =>
    (noProfileUsers.get() ?? []).length === 0 &&
    noProfileCard.isJoined === false
  );

  const assert_offers_join_with_profile = assert(() => {
    const ui = alexCard[UI];
    return hasText(ui, "Join as Alex") &&
      findByProp(ui, "data-profile-identity", "canonical") !== undefined;
  });

  const assert_joined_and_hosts = assert(() => {
    const roster = users.get() ?? [];
    return roster.length === 1 &&
      roster[0]?.name === "Alex" &&
      roster[0]?.avatar === "alex.png" &&
      equals(roster[0]?.profile, alexProfile) &&
      alexCard.isJoined === true &&
      alexCard.isAdmin === true;
  });

  // Joining twice is a no-op: the entry is found by identity, not by name.
  const assert_join_is_idempotent = assert(() =>
    (users.get() ?? []).length === 1
  );

  // The whole point: a second person named "Alex" is a second participant.
  const assert_same_name_two_people = assert(() => {
    const roster = users.get() ?? [];
    return roster.length === 2 &&
      roster[0]?.name === "Alex" &&
      roster[1]?.name === "Alex" &&
      equals(roster[0]?.profile, alexProfile) &&
      equals(roster[1]?.profile, otherAlexProfile) &&
      otherAlexCard.isJoined === true &&
      // Sharing a name does not share host status.
      otherAlexCard.isAdmin === false;
  });

  const assert_host_transferred = assert(() =>
    otherAlexCard.isAdmin === true && alexCard.isAdmin === false
  );

  // A rename changes what the viewer is called, not who they are: the stored
  // entry still matches them, so they stay joined and stay one participant.
  const assert_rename_keeps_identity = assert(() =>
    alexCard.isJoined === true &&
    (users.get() ?? []).length === 2 &&
    hasText(alexCard[UI], "") === true
  );

  return {
    [TESTS]: [
      { assertion: assert_setup_surface_without_profile },
      { action: action_join_with_no_profile },
      { assertion: assert_no_profile_cannot_join },
      { assertion: assert_offers_join_with_profile },
      { action: action_join_as_alex },
      { assertion: assert_joined_and_hosts },
      { action: action_join_again },
      { assertion: assert_join_is_idempotent },
      { action: action_join_as_other_alex },
      { assertion: assert_same_name_two_people },
      { action: action_other_alex_claims_host },
      { assertion: assert_host_transferred },
      { action: action_rename_alex },
      { assertion: assert_rename_keeps_identity },
    ],
    alexCard,
  };
});
