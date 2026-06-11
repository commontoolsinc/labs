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

  // A remove event without a cell must be a no-op — the consolidated
  // mutateElements writer dispatches on the instance's bound mode, so a
  // malformed remove must never fall through to an add (cf-review on
  // CT-1698).
  const action_remove_with_empty_event = action(() => {
    profile.removeElement.send({});
  });

  const action_clear_name = action(() => {
    profile.setName.send({ name: "" });
  });

  const action_set_name = action(() => {
    profile.setName.send({ name: "Grace Hopper" });
  });

  const assert_initial_state = computed(() =>
    profile.initialNameApplied === "Ada Lovelace" &&
    profile.elements.length === 0
  );

  const assert_name_set = computed(() =>
    profile.initialNameApplied === "Grace Hopper"
  );

  const assert_name_cleared = computed(() => profile.initialNameApplied === "");

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
      { action: action_set_name },
      { assertion: assert_name_set },
      { action: action_clear_name },
      { assertion: assert_name_cleared },
      // Add/remove exercise the full owner-protected element write stack:
      // the same-transaction card instantiation linked into the
      // writeAuthorizedBy-protected list (prepare's setup-schema / child-doc
      // link-label hatches) and the single authorized `mutateElements`
      // writer behind every mutation surface (CT-1698).
      { action: action_add_catalog_element },
      { assertion: assert_added_element },
      { action: action_remove_catalog_element },
      { assertion: assert_removed_element },
      { action: action_remove_with_empty_event },
      { assertion: assert_removed_element },
    ],
  };
});
