import { action, computed, pattern } from "commonfabric";
import ProfileHome from "./profile-home.tsx";

export default pattern(() => {
  const profile = ProfileHome({ initialName: "Ada Lovelace" });

  const action_add_catalog_element = action(() => {
    profile.addElement.send({
      catalogId: "profile-card",
      title: "Profile card",
      tag: "profile-card",
      userTags: ["person"],
    });
  });

  const action_remove_catalog_element = action(() => {
    const first = profile.elements[0];
    if (first) {
      profile.removeElement.send({ cell: first.cell });
    }
  });

  const assert_initial_state = computed(() =>
    profile.initialNameApplied === "Ada Lovelace" &&
    profile.elements.length === 0
  );

  const assert_added_element = computed(() => {
    const element = profile.elements[0];
    return profile.elements.length === 1 &&
      element?.tag === "profile-card" &&
      element?.title === "Profile card" &&
      element?.userTags.includes("person") === true;
  });

  const assert_removed_element = computed(() => profile.elements.length === 0);

  return {
    tests: [
      { assertion: assert_initial_state },
      { action: action_add_catalog_element },
      { assertion: assert_added_element },
      { action: action_remove_catalog_element },
      { assertion: assert_removed_element },
    ],
  };
});
