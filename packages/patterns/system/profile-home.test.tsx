import { action, assert, pattern, TESTS } from "commonfabric";
import ProfileHome from "./profile-home.tsx";

export default pattern(() => {
  const profile = ProfileHome({ initialName: "Ada Lovelace" });

  const assert_initial_name_fallback = assert(() =>
    profile.initialNameApplied === "Ada Lovelace"
  );
  const action_initialize_name = action(() => {
    profile.setName.send({ name: "Ada Lovelace" });
  });

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
  // The share inbox pointer (2026-09-15): both parts shaped or nothing.
  const INBOX_SPACE = "did:key:z6MkinboxAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const action_set_inbox = action(() => {
    profile.setInbox.send({
      space: INBOX_SPACE,
      host: "https://estuary.example.ts.net/",
    });
  });
  const action_set_inbox_half = action(() => {
    profile.setInbox.send({
      space: INBOX_SPACE,
      host: "estuary.example.ts.net",
    });
  });
  const action_set_inbox_with_credentials = action(() => {
    profile.setInbox.send({
      space: INBOX_SPACE,
      host: "https://alice:secret@estuary.example.ts.net",
    });
  });
  const action_set_inbox_with_a_path_and_query = action(() => {
    profile.setInbox.send({
      space: INBOX_SPACE,
      host: "https://estuary.example.ts.net/api?x=1",
    });
  });
  const action_set_inbox_with_a_loose_did = action(() => {
    profile.setInbox.send({
      space: "did:key:not-base58-0OIl",
      host: "https://estuary.example.ts.net",
    });
  });
  const action_clear_inbox = action(() => {
    profile.setInbox.send({});
  });
  const assert_inbox_empty_at_birth = assert(() =>
    profile.inbox?.space === "" && profile.inbox?.host === ""
  );
  const assert_inbox_set_with_the_host_trimmed = assert(() =>
    profile.inbox?.space === INBOX_SPACE &&
    profile.inbox?.host === "https://estuary.example.ts.net"
  );
  const assert_inbox_kept_over_a_half_pointer = assert(() =>
    profile.inbox?.space === INBOX_SPACE &&
    profile.inbox?.host === "https://estuary.example.ts.net"
  );
  const assert_inbox_cleared = assert(() =>
    profile.inbox?.space === "" && profile.inbox?.host === ""
  );

  // CT-1828: same empty-after-trim guard applies to setAvatar.
  const action_clear_avatar = action(() => {
    profile.setAvatar.send({ avatar: "" });
  });

  // CT-1748 note: the presentation-vs-edit *content* lives behind `ifElse`, and
  // [UI] vnode traversal doesn't resolve through this test harness's `.get()`,
  // so the toggle is asserted via the exported `isEditing` and the bound data
  // below. The rendered presentation itself (real cf-profile-badge + card tiles,
  // distinct from the edit form) is verified in the browser.

  // Visiting a profile starts in the read-only presentation, not the edit form.
  const assert_not_editing = assert(() => profile.isEditing === false);
  // The toggle flips into the edit form, then back.
  const assert_editing = assert(() => profile.isEditing === true);

  // The avatar the badge binds resolves (single context — owner-protected reads
  // are clean here; cross-stamp masking is the browser-only CT-1740 issue).
  const assert_avatar_set = assert(() => profile.avatar === "AL");
  // CT-1828: an empty send must not clear a previously-set avatar.
  const assert_avatar_unchanged_after_empty = assert(() =>
    profile.avatar === "AL"
  );

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

  // CT-1828: an empty (or whitespace-only) send must be a no-op — it must
  // NOT clear the canonical name. Clearing here would fall back to the
  // literal "Profile" display product-wide (unlike setBio, which is
  // deliberately left clearable).
  const action_clear_name = action(() => {
    profile.setName.send({ name: "" });
  });

  const action_whitespace_name = action(() => {
    profile.setName.send({ name: "   " });
  });

  const action_set_name = action(() => {
    profile.setName.send({ name: "Grace Hopper" });
  });

  const action_add_external_profile_link = action(() => {
    profile.addExternalLink.send({
      label: "GitHub",
      url: "https://github.com/gracehopper",
    });
  });

  const action_add_unsafe_external_profile_link = action(() => {
    profile.addExternalLink.send({
      label: "Unsafe",
      url: "javascript:alert(1)",
    });
  });

  const action_remove_external_profile_link = action(() => {
    profile.removeExternalLink.send({
      url: "https://github.com/gracehopper",
    });
  });

  const assert_initial_state = assert(() =>
    profile.name === "Ada Lovelace" &&
    profile.initialNameApplied === "Ada Lovelace" &&
    profile.externalLinks.length === 0 &&
    profile.verifiedIdentities.length === 0 &&
    profile.elements.length === 0
  );

  const assert_name_set = assert(() =>
    profile.initialNameApplied === "Grace Hopper"
  );

  // The prior (non-empty) name must survive both an empty and a
  // whitespace-only send.
  const assert_name_unchanged_after_empty = assert(() =>
    profile.initialNameApplied === "Grace Hopper"
  );

  const assert_external_profile_link_added = assert(() =>
    profile.externalLinks.length === 1 &&
    profile.externalLinks[0]?.label === "GitHub" &&
    profile.externalLinks[0]?.url === "https://github.com/gracehopper"
  );

  const assert_unsafe_external_profile_link_rejected = assert(() =>
    profile.externalLinks.length === 1
  );

  const assert_external_profile_link_removed = assert(() =>
    profile.externalLinks.length === 0
  );

  const assert_added_element = assert(() => {
    const element = profile.elements[0];
    return profile.elements.length === 1 &&
      element?.tag === "#profileCard" &&
      element?.title === "Profile card" &&
      element?.userTags.includes("person") === true;
  });

  const assert_removed_element = assert(() => profile.elements.length === 0);

  return {
    [TESTS]: [
      { assertion: assert_initial_name_fallback },
      { action: action_initialize_name },
      { assertion: assert_inbox_empty_at_birth },
      { action: action_set_inbox },
      { assertion: assert_inbox_set_with_the_host_trimmed },
      { action: action_set_inbox_half },
      { assertion: assert_inbox_kept_over_a_half_pointer },
      { action: action_set_inbox_with_credentials },
      { assertion: assert_inbox_kept_over_a_half_pointer },
      { action: action_set_inbox_with_a_path_and_query },
      { assertion: assert_inbox_kept_over_a_half_pointer },
      { action: action_set_inbox_with_a_loose_did },
      { assertion: assert_inbox_kept_over_a_half_pointer },
      { action: action_clear_inbox },
      { assertion: assert_inbox_cleared },
      { assertion: assert_initial_state },
      // CT-1748: a freshly-visited profile starts in the read-only
      // presentation, not the edit form.
      { assertion: assert_not_editing },
      { action: action_set_name },
      { assertion: assert_name_set },
      // CT-1828: empty and whitespace-only sends must not erase the name.
      { action: action_clear_name },
      { assertion: assert_name_unchanged_after_empty },
      { action: action_whitespace_name },
      { assertion: assert_name_unchanged_after_empty },
      // External profile links are owner-authored public https links. Unsafe
      // schemes are rejected at write time, then the owner can remove a link.
      { action: action_add_external_profile_link },
      { assertion: assert_external_profile_link_added },
      { action: action_add_unsafe_external_profile_link },
      { assertion: assert_unsafe_external_profile_link_rejected },
      { action: action_remove_external_profile_link },
      { assertion: assert_external_profile_link_removed },
      // CT-1748: the avatar the badge binds resolves.
      { action: action_set_avatar },
      { assertion: assert_avatar_set },
      // CT-1828: an empty send must not erase the avatar either.
      { action: action_clear_avatar },
      { assertion: assert_avatar_unchanged_after_empty },
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
