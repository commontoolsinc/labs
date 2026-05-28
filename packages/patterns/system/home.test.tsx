import { action, computed, pattern } from "commonfabric";
import Home from "./home.tsx";

export default pattern(() => {
  const home = Home({});

  const action_create_profile = action(() => {
    home.createProfile.send({ detail: { message: "Ada Lovelace" } });
  });

  const assert_initial_profile_missing = computed(() =>
    home.profile === undefined
  );

  const assert_profile_created_with_name = computed(() =>
    home.profile?.name === "Ada Lovelace"
  );

  return {
    tests: [
      { assertion: assert_initial_profile_missing },
      { action: action_create_profile },
      { assertion: assert_profile_created_with_name },
    ],
  };
});
