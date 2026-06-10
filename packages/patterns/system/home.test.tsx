import { computed, pattern } from "commonfabric";
import Home from "./home.tsx";

export default pattern(() => {
  const home = Home({});

  const assert_initial_profile_missing = computed(() =>
    ((home.profiles as unknown[])?.length ?? 0) === 0
  );

  // NOTE: untrusted-write protection (sending the exported `createProfile`
  // stream from outside the trusted ProfileCreate surface must NOT create a
  // profile) is enforced by CFC and verified in
  // packages/runner/test/profile-owner-cfc.test.ts under `enforce-explicit`.
  // It can't be asserted here: the pattern-test runner runs CFC in `observe`
  // mode (no enforcement), so an untrusted send is not blocked. The previous
  // version of this test only "passed" because the untrusted cross-space
  // `inSpace` write incidentally threw a write-isolation error — which the
  // multi-profile change legitimately allows via a multi-space commit.

  return {
    tests: [
      { assertion: assert_initial_profile_missing },
    ],
  };
});
