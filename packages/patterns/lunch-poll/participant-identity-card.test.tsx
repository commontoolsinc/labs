import { action, computed, Default, pattern, Writable } from "commonfabric";
import ParticipantIdentityCard from "./participant-identity-card.tsx";
import type { User } from "./main.tsx";

export default pattern(() => {
  const users = new Writable<User[] | Default<[]>>([]);
  const myName = new Writable<string | Default<"">>("");
  const myUserIndex = new Writable<number | Default<-1>>(-1);
  const adminName = new Writable<string | Default<"">>("");
  const participantIdentity = ParticipantIdentityCard({
    users,
    myName,
    myUserIndex,
    adminName,
  });

  const action_join_as_alex = action(() => {
    participantIdentity.joinAs.send({ name: "Alex" });
  });

  const action_try_rejoin_as_alex_two = action(() => {
    participantIdentity.joinAs.send({ name: "Alex Two" });
  });

  const action_switch_to_blair = action(() => {
    users.push({
      id: "u_blair",
      name: "Blair",
      avatar: "",
      color: "#c2573a",
      joinedAt: 1,
      votes: [],
    });
    myName.set("Blair");
    myUserIndex.set(1);
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

  const assert_joined_as_alex = computed(() => {
    const currentUsers = users.get();
    const userId = currentUsers[0]?.id ?? "";
    return currentUsers.length === 1 &&
      typeof currentUsers[0]?.id === "string" &&
      userId !== "" &&
      currentUsers[0]?.name === "Alex" &&
      currentUsers[0]?.votes?.length === 0 &&
      myName.get() === "Alex" &&
      myUserIndex.get() === 0 &&
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
