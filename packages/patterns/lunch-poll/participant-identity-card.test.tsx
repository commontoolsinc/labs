import { action, computed, Default, pattern, Writable } from "commonfabric";
import ParticipantIdentityCard from "./participant-identity-card.tsx";
import type { User } from "./main.tsx";

export default pattern(() => {
  const users = new Writable<User[] | Default<[]>>([]);
  const myName = new Writable<string | Default<"">>("");
  const adminName = new Writable<string | Default<"">>("");
  const participantIdentity = ParticipantIdentityCard({
    users,
    myName,
    adminName,
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
      { assertion: assert_initial },
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
