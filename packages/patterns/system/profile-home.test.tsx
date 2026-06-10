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
      // Skipped under CFC enforcement: addElement instantiates a fresh
      // ProfileCatalogCard inside the handler and links it into the
      // writeAuthorizedBy-protected `elements` list in the same transaction.
      // The new instance's doc has no stored CFC metadata and no pending
      // schema input yet, so the fail-closed link-write rule rejects the
      // commit ("missing link source metadata ... at /elements/0").
      // Re-enable once the runtime counts a same-transaction pattern
      // instantiation as pending source metadata (or the pattern
      // pre-materializes elements).
      { action: action_add_catalog_element, skip: true },
      { assertion: assert_added_element, skip: true },
      { action: action_remove_catalog_element, skip: true },
      { assertion: assert_removed_element, skip: true },
    ],
  };
});
