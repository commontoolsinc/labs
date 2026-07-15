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
  const assert_not_editing = computed(() => profile.isEditing === false);
  // The toggle flips into the edit form, then back.
  const assert_editing = computed(() => profile.isEditing === true);

  // The avatar the badge binds resolves (single context — owner-protected reads
  // are clean here; cross-stamp masking is the browser-only CT-1740 issue).
  const assert_avatar_set = computed(() => profile.avatar === "AL");
  // CT-1828: an empty send must not clear a previously-set avatar.
  const assert_avatar_unchanged_after_empty = computed(() =>
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

  const action_publish_verified_identities = action(() => {
    profile.publishVerifiedIdentities.send({
      identities: [
        {
          type: "github.node_id",
          value: "MDQ6VXNlcjY2NTc3",
          verifiedAt: "2026-07-15T12:00:00.000Z",
        },
        {
          type: "github.login",
          value: "gracehopper",
          verifiedAt: "2026-07-15T12:00:00.000Z",
        },
      ],
    });
  });

  const action_refresh_verified_identity = action(() => {
    profile.publishVerifiedIdentities.send({
      identities: [{
        type: "github.login",
        value: "gracehopper",
        verifiedAt: "2026-07-16T12:00:00.000Z",
      }],
    });
  });

  const action_reject_invalid_verified_identity = action(() => {
    profile.publishVerifiedIdentities.send({
      identities: [
        {
          type: "github.login",
          value: "unverified",
          verifiedAt: "not-a-timestamp",
        },
        {
          type: "github.login",
          value: "impossible-date",
          verifiedAt: "2026-02-31T00:00:00Z",
        },
      ],
    });
  });

  const action_publish_delimiter_identity = action(() => {
    profile.publishVerifiedIdentities.send({
      identities: [{
        type: "collision",
        value: "left\u0000right",
        verifiedAt: "2026-07-16T12:00:00Z",
      }],
    });
  });

  const action_revoke_colliding_but_distinct_identity = action(() => {
    profile.revokeVerifiedIdentities.send({
      identities: [{ type: "collision\u0000left", value: "right" }],
    });
  });

  const action_revoke_verified_identity = action(() => {
    profile.revokeVerifiedIdentities.send({
      identities: [{
        type: "github.login",
        value: "gracehopper",
      }],
    });
  });

  const assert_initial_state = computed(() =>
    profile.initialNameApplied === "Ada Lovelace" &&
    profile.externalLinks.length === 0 &&
    profile.verifiedIdentities.length === 0 &&
    profile.elements.length === 0
  );

  const assert_name_set = computed(() =>
    profile.initialNameApplied === "Grace Hopper"
  );

  // The prior (non-empty) name must survive both an empty and a
  // whitespace-only send.
  const assert_name_unchanged_after_empty = computed(() =>
    profile.initialNameApplied === "Grace Hopper"
  );

  const assert_external_profile_link_added = computed(() =>
    profile.externalLinks.length === 1 &&
    profile.externalLinks[0]?.label === "GitHub" &&
    profile.externalLinks[0]?.url === "https://github.com/gracehopper"
  );

  const assert_unsafe_external_profile_link_rejected = computed(() =>
    profile.externalLinks.length === 1
  );

  const assert_external_profile_link_removed = computed(() =>
    profile.externalLinks.length === 0
  );

  const assert_verified_identities_published = computed(() =>
    profile.verifiedIdentities.length === 2 &&
    profile.verifiedIdentities[0]?.type === "github.node_id" &&
    profile.verifiedIdentities[0]?.value === "MDQ6VXNlcjY2NTc3" &&
    profile.verifiedIdentities[1]?.type === "github.login" &&
    profile.verifiedIdentities[1]?.value === "gracehopper"
  );

  const assert_verified_identity_refreshed = computed(() =>
    profile.verifiedIdentities.length === 2 &&
    profile.verifiedIdentities[1]?.verifiedAt ===
      "2026-07-16T12:00:00.000Z"
  );

  const assert_verified_identity_revoked = computed(() =>
    profile.verifiedIdentities.length === 2 &&
    profile.verifiedIdentities.some((identity) =>
      identity.type === "github.node_id"
    ) &&
    !profile.verifiedIdentities.some((identity) =>
      identity.type === "github.login"
    )
  );

  const assert_delimiter_identity_preserved = computed(() =>
    profile.verifiedIdentities.some((identity) =>
      identity.type === "collision" && identity.value === "left\u0000right"
    )
  );

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
      // A successful connector login publishes separately useful stable and
      // human-facing identifiers. Re-publishing the same tuple refreshes its
      // timestamp without collapsing other identities of that provider.
      { action: action_publish_verified_identities },
      { assertion: assert_verified_identities_published },
      { action: action_refresh_verified_identity },
      { assertion: assert_verified_identity_refreshed },
      // Malformed timestamps can never become authoritative assertions.
      { action: action_reject_invalid_verified_identity },
      { assertion: assert_verified_identity_refreshed },
      // Tuple keys must remain exact even if either field contains the old
      // delimiter; revoking a distinct tuple cannot remove this assertion.
      { action: action_publish_delimiter_identity },
      { assertion: assert_delimiter_identity_preserved },
      { action: action_revoke_colliding_but_distinct_identity },
      { assertion: assert_delimiter_identity_preserved },
      // Opting out or logging out revokes the exact assertions that connector
      // previously published; other verified values remain intact.
      { action: action_revoke_verified_identity },
      { assertion: assert_verified_identity_revoked },
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
