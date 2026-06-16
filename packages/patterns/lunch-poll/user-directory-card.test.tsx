import { action, computed, Default, pattern, Writable } from "commonfabric";
import UserDirectoryCard from "./user-directory-card.tsx";
import type { User } from "./main.tsx";

export default pattern(() => {
  const users = new Writable<User[] | Default<[]>>([]);
  const myName = new Writable<string | Default<"">>("");
  const adminName = new Writable<string | Default<"">>("");
  const directory = UserDirectoryCard({ users, myName, adminName });

  const action_join_as_alex = action(() => {
    directory.joinAs.send({ name: "Alex" });
  });

  const action_try_rejoin_as_alex_two = action(() => {
    directory.joinAs.send({ name: "Alex Two" });
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
    directory.claimHost.send({});
  });

  const assert_initial = computed(() =>
    users.get().length === 0 &&
    directory.me === "" &&
    directory.isJoined === false &&
    directory.isAdmin === false
  );

  const assert_joined_as_alex = computed(() => {
    const currentUsers = users.get();
    return currentUsers.length === 1 &&
      currentUsers[0]?.name === "Alex" &&
      myName.get() === "Alex" &&
      adminName.get() === "Alex" &&
      directory.me === "Alex" &&
      directory.isJoined === true &&
      directory.isAdmin === true;
  });

  const assert_rejoin_noop = computed(() => {
    const currentUsers = users.get();
    return currentUsers.length === 1 &&
      currentUsers[0]?.name === "Alex" &&
      myName.get() === "Alex";
  });

  const assert_blair_is_not_host = computed(() =>
    users.get().length === 2 &&
    directory.me === "Blair" &&
    adminName.get() === "Alex" &&
    directory.isJoined === true &&
    directory.isAdmin === false
  );

  const assert_blair_claimed_host = computed(() =>
    adminName.get() === "Blair" &&
    directory.me === "Blair" &&
    directory.isAdmin === true
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
    directory,
  };
});
