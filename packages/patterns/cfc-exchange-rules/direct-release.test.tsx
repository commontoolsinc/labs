import { computed, pattern } from "commonfabric";
import DirectRelease from "./direct-release.tsx";

export default pattern(() => {
  const defaultRelease = DirectRelease({});
  const customRelease = DirectRelease({ message: "Review-ready summary" });

  const assert_default_message = computed(() =>
    defaultRelease.message === "Private until reader evidence is present"
  );
  const assert_custom_message = computed(() =>
    customRelease.message === "Review-ready summary"
  );

  return {
    tests: [
      { assertion: assert_default_message },
      { assertion: assert_custom_message },
    ],
    defaultRelease,
    customRelease,
  };
});
