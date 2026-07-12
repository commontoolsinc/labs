import { computed, pattern } from "commonfabric";
import ImportedPolicy from "./imported-policy.tsx";

export default pattern(() => {
  const defaultPolicy = ImportedPolicy({});
  const customPolicy = ImportedPolicy({ message: "Imported policy message" });

  return {
    tests: [
      {
        assertion: computed(() =>
          defaultPolicy.message ===
            "Protected by the defining module's rules"
        ),
      },
      {
        assertion: computed(() =>
          customPolicy.message === "Imported policy message"
        ),
      },
    ],
  };
});
