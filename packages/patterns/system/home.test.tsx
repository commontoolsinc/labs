import { action, computed, pattern } from "commonfabric";
import Home from "./home.tsx";

export default pattern(() => {
  const home = Home({});

  const action_create_profile = action(() => {
    home.createProfile.send({ name: "Ada Lovelace" });
  });

  const assert_initial_profile_missing = computed(() =>
    ((home.profiles as unknown[])?.length ?? 0) === 0
  );

  const assert_untrusted_stream_does_not_create_profile = computed(() =>
    ((home.profiles as unknown[])?.length ?? 0) === 0
  );

  return {
    tests: [
      { assertion: assert_initial_profile_missing },
      { action: action_create_profile },
      { assertion: assert_untrusted_stream_does_not_create_profile },
    ],
  };
});
