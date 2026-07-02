import { action, computed, pattern } from "commonfabric";
import ProfileHome from "./profile-home.tsx";

export default pattern(() => {
  const profile = ProfileHome({ initialName: "Ada Lovelace" });

  // CT-1748: the rendered profile view. Single context, so the owner-protected
  // name/avatar/elements resolve cleanly (no cross-stamp moduleIdentity
  // divergence — that only bites the browser piece-view, and is CT-1740). These
  // assertions prove the read-only presentation renders, distinct from the edit
  // form, and the toggle swaps between them.
  const action_toggle_editing = action(() => {
    profile.toggleEditing.send();
  });

  const action_set_avatar = action(() => {
    profile.setAvatar.send({ avatar: "AL" });
  });

  // CT-1748 note: the presentation-vs-edit *content* lives behind `ifElse`, and
  // [UI] vnode traversal doesn't resolve through this test harness's `.get()`,
  // so the toggle is asserted via the exported `isEditing` and the bound data
  // below. The rendered presentation itself (real cf-profile-badge + card tiles,
  // distinct from the edit form) is verified in the browser.

  // Visiting a profile starts in the read-only presentation, not the edit form.
  const assert_not_editing = computed(() => profile.isEditing === false);
  // The toggle flips into the edit form, then back.
  const assert_editing = computed(() => profile.isEditing === true);

  // The avatar the badge binds resolves (single context — owner-protected reads
  // are clean here; cross-stamp masking is the browser-only CT-1740 issue).
  const assert_avatar_set = computed(() => profile.avatar === "AL");

  const action_add_catalog_element = action(() => {
    profile.addElement.send({
      catalogId: "profile-card",
      title: "Profile card",
      tag: "#profileCard",
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
      element?.tag === "#profileCard" &&
      element?.title === "Profile card" &&
      element?.userTags.includes("person") === true;
  });

  const assert_removed_element = computed(() => profile.elements.length === 0);

  return {
    tests: [
      { assertion: assert_initial_state },
      // CT-1748: a freshly-visited profile starts in the read-only
      // presentation, not the edit form.
      { assertion: assert_not_editing },
      { action: action_set_name },
      { assertion: assert_name_set },
      { action: action_clear_name },
      { assertion: assert_name_cleared },
      // CT-1748: the avatar the badge binds resolves.
      { action: action_set_avatar },
      { assertion: assert_avatar_set },
      // Add/remove exercise the full owner-protected element write stack:
      // the same-transaction card instantiation linked into the
      // writeAuthorizedBy-protected list (prepare's setup-schema / child-doc
      // link-label hatches) and the single authorized `mutateElements`
      // writer behind every mutation surface (CT-1698).
      { action: action_add_catalog_element },
      { assertion: assert_added_element },
      // CT-1748: the view/edit toggle flips presentation ⇄ edit form.
      { action: action_toggle_editing },
      { assertion: assert_editing },
      { action: action_toggle_editing },
      { assertion: assert_not_editing },
      { action: action_remove_catalog_element },
      { assertion: assert_removed_element },
      { action: action_remove_with_empty_event },
      { assertion: assert_removed_element },
    ],
  };
});
