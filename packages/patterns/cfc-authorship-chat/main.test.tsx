import { computed, pattern } from "commonfabric";
import AuthorshipChat from "./main.tsx";

export default pattern(() => {
  const instance = AuthorshipChat({});

  const assert_verified_fixture_names_alice = computed(() =>
    instance.verifiedAuthor === "Alice Nguyen"
  );
  const assert_forged_fixture_names_bob = computed(() =>
    instance.forgedClaim === "Bob Patel"
  );
  const assert_unsigned_fixture_names_casey = computed(() =>
    instance.unsignedState === "Casey Morgan"
  );

  return {
    tests: [
      { assertion: assert_verified_fixture_names_alice },
      { assertion: assert_forged_fixture_names_bob },
      { assertion: assert_unsigned_fixture_names_casey },
    ],
    instance,
  };
});
