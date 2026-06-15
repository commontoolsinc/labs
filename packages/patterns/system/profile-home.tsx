import {
  Cfc,
  computed,
  equals,
  handler,
  ifElse,
  lift,
  NAME,
  pattern,
  RepresentsCurrentUser,
  Stream,
  UI,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";

export const TRUSTED_PROFILE_HOME_SURFACE = "ProfileHome";
export const TRUSTED_PROFILE_EDIT_ACTION = "EditProfile";

type CurrentPrincipal = { readonly __ctCurrentPrincipal: true };

type OwnerProtectedProfileWrite<
  T,
  Binding,
> = RepresentsCurrentUser<
  Cfc<
    WriteAuthorizedBy<T, Binding>,
    {
      ownerPrincipal: CurrentPrincipal;
    }
  >
>;

type ProfileElementCell = {
  [NAME]?: string;
};

// NOTE(CT-1628): `cell: any` here/below and the `(Pattern(...) as any).for(...)`
// casts later in this file are required until the CFC wrapper / pattern-factory
// types expose a typed cell ref and `.for()`. Tracked for a proper type fix.
export type ProfileElement = {
  cell: any;
  tag: string;
  userTags: readonly string[];
  title?: string;
  source?: "catalog" | "url";
};

export type AddProfileElementEvent = {
  catalogId?: string;
  patternUrl?: string;
  title?: string;
  tag?: string;
  userTags?: readonly string[];
};

export type RemoveProfileElementEvent = {
  cell: any;
};

/**
 * The single event shape for every element mutation (see `mutateElements`):
 * a `cell` (from the event or the instance's bound state) removes that
 * element; a `patternUrl` (or a bound link form) adds a link reference card;
 * otherwise a catalog card is added. `AddProfileElementEvent` /
 * `RemoveProfileElementEvent` are subsets kept for the exported stream types.
 */
export type MutateProfileElementsEvent = {
  catalogId?: string;
  patternUrl?: string;
  title?: string;
  tag?: string;
  userTags?: readonly string[];
  cell?: any;
};

export type SetProfileNameEvent = {
  name?: string;
  detail?: { message?: string };
  key?: string;
  target?: { value?: string };
};

export type SetProfileAvatarEvent = {
  avatar?: string;
  detail?: { message?: string };
  key?: string;
  target?: { value?: string };
};

export type ProfileHomeOutput = {
  [NAME]: string;
  [UI]: unknown;
  name: OwnerProtectedProfileWrite<string, typeof setName>;
  avatar: OwnerProtectedProfileWrite<string, typeof setAvatar>;
  elements: OwnerProtectedProfileWrite<ProfileElement[], typeof mutateElements>;
  setName: Stream<SetProfileNameEvent>;
  setAvatar: Stream<SetProfileAvatarEvent>;
  // Both element streams accept the full mutation event (the union shape of
  // the one authorized writer); `AddProfileElementEvent` /
  // `RemoveProfileElementEvent` remain the documented per-stream subsets.
  addElement: Stream<MutateProfileElementsEvent>;
  removeElement: Stream<MutateProfileElementsEvent>;
  // Flips the rendered profile view (CT-1748) between the read-only
  // presentation and the edit form. UI state — not owner-protected.
  toggleEditing: Stream<unknown>;
  // Current view mode: false = read-only presentation, true = edit form.
  isEditing: boolean;
  initialNameApplied: string;
};

export type ProfileHomeInput = {
  initialName?: string;
};

const trimInitialName = (initialName?: string): string =>
  (initialName ?? "").trim();

const ProfileCatalogCard = pattern<{ title: string }, ProfileElementCell>(
  ({ title }) => ({
    [NAME]: title,
    [UI]: (
      <cf-vstack gap="2" style={{ padding: "12px" }}>
        <strong>{title}</strong>
      </cf-vstack>
    ),
  }),
);

const UrlPatternReference = pattern<
  { title: string; url: string },
  ProfileElementCell
>(
  ({ title, url }) => ({
    [NAME]: title,
    [UI]: (
      <cf-vstack gap="2" style={{ padding: "12px" }}>
        <strong>{title}</strong>
        <span style={{ color: "var(--cf-theme-color-text-secondary)" }}>
          {url}
        </span>
      </cf-vstack>
    ),
  }),
);

const appendElement = (
  element: ProfileElement,
  elements: Writable<ProfileElement[]>,
) => {
  const current = elements.get();
  if (current.some((existing) => equals(existing.cell, element.cell))) {
    return;
  }
  elements.push(element);
};

// THE single authorized writer for the owner-protected `elements` list. A
// `writeAuthorizedBy` claim carries exactly one handler binding, verified
// against the writing handler's implementation identity — so every element
// mutation (the exported add/remove streams, the catalog/link-form buttons,
// the per-row remove) must be an INSTANCE of this one implementation.
// Instances differ only in bound state — including the explicit `mode`
// below — which doesn't change the implementation identity.
const mutateElements = handler<
  MutateProfileElementsEvent,
  {
    elements: Writable<ProfileElement[]>;
    // Instance intent. Each binding site declares what its events may do, so
    // a malformed/empty event can never cross purposes (an empty remove must
    // not add; an empty link form must not add a catalog card):
    //   "add"     — the exported add stream: event-driven, url or catalog.
    //   "addCard" — the catalog button: one fixed "Profile card".
    //   "addLink" — the link form: reads (and clears) the bound form; no-op
    //               without a URL.
    //   "remove"  — the exported remove stream / per-row button: removes
    //               `event.cell ?? state.cell`; no-op without one.
    mode: "add" | "addCard" | "addLink" | "remove";
    // Per-row remove binding ("remove" mode).
    cell?: any;
    // Link form binding ("addLink" mode).
    patternUrl?: Writable<string>;
    title?: Writable<string>;
    tag?: Writable<string>;
    userTags?: string[];
  }
>((event, state) => {
  const userTags = event.userTags ?? state.userTags ?? [];
  switch (state.mode) {
    case "remove": {
      const removeCell = event.cell ?? state.cell;
      if (removeCell === undefined) return;
      state.elements.set(
        state.elements.get().filter((element) =>
          !equals(element.cell, removeCell)
        ),
      );
      return;
    }
    case "addLink": {
      const url = (state.patternUrl?.get() ?? "").trim();
      if (url.length === 0) return;
      const title = (state.title?.get() ?? "").trim() || url;
      const tag = (state.tag?.get() ?? "").trim() || url;
      appendElement({
        cell: (UrlPatternReference({ title, url }) as any).for(tag),
        source: "url",
        title,
        tag,
        userTags,
      }, state.elements);
      state.patternUrl?.set("");
      state.title?.set("");
      state.tag?.set("");
      return;
    }
    case "addCard": {
      appendElement({
        cell: (ProfileCatalogCard({ title: "Profile card" }) as any).for(
          "profile-card",
        ),
        source: "catalog",
        title: "Profile card",
        tag: "profile-card",
        userTags,
      }, state.elements);
      return;
    }
    case "add": {
      const source = event.patternUrl ? "url" : "catalog";
      const title = event.title ??
        (source === "url"
          ? event.patternUrl ?? "Profile pattern"
          : "Profile card");
      const tag = event.tag ?? event.catalogId ?? event.patternUrl ??
        "profile";
      const cell = source === "url"
        ? (UrlPatternReference({ title, url: event.patternUrl ?? "" }) as any)
          .for(tag)
        : (ProfileCatalogCard({ title }) as any).for(tag);
      appendElement({
        cell,
        tag,
        userTags,
        title,
        source,
      }, state.elements);
      return;
    }
  }
});

const setName = handler<SetProfileNameEvent, { name: Writable<string> }>(
  (event, state) => {
    if (event.key !== undefined && event.key !== "Enter") {
      return;
    }
    const name = (event.name ?? event.detail?.message ??
      event.target?.value ?? "").trim();
    state.name.set(name);
  },
);

const setAvatar = handler<SetProfileAvatarEvent, { avatar: Writable<string> }>(
  (event, state) => {
    if (event.key !== undefined && event.key !== "Enter") {
      return;
    }
    const avatar = (event.avatar ?? event.detail?.message ??
      event.target?.value ?? "").trim();
    state.avatar.set(avatar);
  },
);

// View/edit toggle for the rendered profile view (CT-1748). Plain (un-protected)
// UI state: visiting a profile shows the read-only presentation; this flips to
// the edit form. The flag itself is not owner-protected — anyone can flip their
// own view — but CFC still gates the actual field writes behind the form.
const toggleProfileEditing = handler<unknown, { editing: Writable<boolean> }>(
  (_event, state) => {
    state.editing.set(!state.editing.get());
  },
);

const applyInitialName = lift<
  { initialName?: string; name: Writable<string> },
  string
>(({ initialName, name }) => {
  return name.get() ?? trimInitialName(initialName);
});

export default pattern<ProfileHomeInput, ProfileHomeOutput>(
  ({ initialName }) => {
    const initialProfileName = trimInitialName(initialName);
    const name = new Writable<
      OwnerProtectedProfileWrite<string, typeof setName>
    >(initialProfileName).for("name");
    const avatar = new Writable<
      OwnerProtectedProfileWrite<string, typeof setAvatar>
    >("").for("avatar");
    const elements = new Writable<
      OwnerProtectedProfileWrite<ProfileElement[], typeof mutateElements>
    >([]).for("elements");
    const patternUrl = new Writable("").for("patternUrl");
    const elementTitle = new Writable("").for("elementTitle");
    const elementTag = new Writable("").for("elementTag");
    const userTagsText = new Writable("").for("userTagsText");
    // Rendered profile view (CT-1748): the cell view shows a read-only
    // presentation by default; the owner flips this to reveal the edit form.
    const editing = new Writable<boolean>(false).for("editing");
    const isEditing = computed(() => editing.get() === true);
    // Self-view cell for <cf-profile-badge>: the badge resolves name/avatar from
    // a bound profile cell. Bound to this derived self-cell it renders in the
    // "presented" state. TODO(CT-1748 follow-up): bind the actual profile result
    // cell so the runtime-attested represents-principal label drives the
    // verified identity seal (needs owner-protection restored + CT-1740).
    const selfProfile = computed(() => ({
      [NAME]: name.get(),
      name: name.get(),
      avatar: avatar.get(),
    }));

    const parsedUserTags = computed(() =>
      userTagsText.get().split(",").map((tag) => tag.trim()).filter((tag) =>
        tag.length > 0
      )
    );
    const initialNameApplied = applyInitialName({ initialName, name });
    // A profile's display name is the person's name (falls back to "Profile"
    // before one is set). This drives cf-cell-link labels in the picker and
    // anywhere a profile link is rendered.
    const displayName = computed(() => {
      const applied = initialNameApplied;
      return typeof applied === "string" && applied.trim().length > 0
        ? applied
        : "Profile";
    });

    return {
      [NAME]: displayName,
      name,
      avatar,
      elements,
      setName: setName({ name }),
      setAvatar: setAvatar({ avatar }),
      // Both exported streams are instances of the one authorized writer,
      // pinned to their declared purpose via the bound mode.
      addElement: mutateElements({ elements, mode: "add" }),
      removeElement: mutateElements({ elements, mode: "remove" }),
      toggleEditing: toggleProfileEditing({ editing }),
      isEditing,
      initialNameApplied,
      [UI]: (
        <cf-screen
          data-ui-pattern={TRUSTED_PROFILE_HOME_SURFACE}
          data-ui-event-integrity={TRUSTED_PROFILE_HOME_SURFACE}
        >
          <cf-toolbar slot="header" sticky>
            <div slot="start">
              <h2 style={{ margin: 0, fontSize: "18px" }}>Profile</h2>
            </div>
          </cf-toolbar>

          <cf-vstack gap="4" style={{ padding: "16px", maxWidth: "720px" }}>
            {
              /* CT-1748: read-only presentation — what you see when you visit a
                profile cell. The edit form is gated behind the toggle below. */
            }
            {ifElse(
              isEditing,
              null,
              <cf-vstack gap="4" data-ui-region="profile-presentation">
                <cf-profile-badge
                  id="profile-badge"
                  $profile={selfProfile}
                  size="xl"
                />

                <cf-vstack gap="2">
                  {elements.map((element) => (
                    <div
                      style={{
                        border:
                          "0.5px solid var(--cf-theme-color-border, #e5e5e7)",
                        borderRadius: "12px",
                        padding: "12px 14px",
                      }}
                    >
                      <cf-hstack justify="between" align="center" gap="2">
                        <cf-vstack gap="1">
                          <strong>{element.title ?? element.tag}</strong>
                          <div
                            style={{
                              color: "var(--cf-theme-color-text-secondary)",
                              fontSize: "13px",
                            }}
                          >
                            {element.userTags.map((tag) => `#${tag}`).join(" ")}
                          </div>
                        </cf-vstack>
                        <cf-cell-link $cell={element.cell}>Open</cf-cell-link>
                      </cf-hstack>
                    </div>
                  ))}
                </cf-vstack>

                <cf-hstack>
                  <cf-button
                    variant="ghost"
                    size="sm"
                    onClick={toggleProfileEditing({ editing })}
                  >
                    Edit profile
                  </cf-button>
                </cf-hstack>
              </cf-vstack>,
            )}

            {/* The existing edit form, now revealed only in edit mode. */}
            {ifElse(
              isEditing,
              <cf-vstack gap="4" data-ui-region="profile-edit">
                <cf-vstack gap="2">
                  <label>Name</label>
                  <strong>{name}</strong>
                  <cf-message-input
                    data-ui-action={TRUSTED_PROFILE_EDIT_ACTION}
                    placeholder="Your name"
                    appearance="rounded"
                    oncf-send={setName({ name })}
                  />
                </cf-vstack>

                <cf-vstack gap="2">
                  <label>Avatar</label>
                  <span>{avatar}</span>
                  <cf-message-input
                    data-ui-action={TRUSTED_PROFILE_EDIT_ACTION}
                    placeholder="Avatar URL or text"
                    appearance="rounded"
                    oncf-send={setAvatar({ avatar })}
                  />
                </cf-vstack>

                <cf-vstack gap="2">
                  <label>Tags</label>
                  <cf-input $value={userTagsText} placeholder="person, work" />
                </cf-vstack>

                <cf-hstack gap="2">
                  <cf-button
                    onClick={mutateElements({
                      elements,
                      mode: "addCard",
                      userTags: parsedUserTags,
                    })}
                  >
                    Add profile card
                  </cf-button>
                </cf-hstack>

                <cf-vstack gap="2">
                  <label>Link URL</label>
                  <cf-input
                    $value={patternUrl}
                    placeholder="/api/patterns/..."
                  />
                  <cf-input $value={elementTitle} placeholder="Title" />
                  <cf-input $value={elementTag} placeholder="Tag" />
                  <cf-button
                    onClick={mutateElements({
                      elements,
                      mode: "addLink",
                      patternUrl,
                      title: elementTitle,
                      tag: elementTag,
                      userTags: parsedUserTags,
                    })}
                  >
                    Add link
                  </cf-button>
                  <span style={{ color: "var(--cf-color-text-secondary)" }}>
                    Links are saved as reference cards. They are not deployed or
                    run.
                  </span>
                </cf-vstack>

                <cf-vstack gap="2">
                  {elements.map((element) => (
                    <cf-hstack gap="2" align="center">
                      <cf-cell-link $cell={element.cell}>
                        {element.title ?? element.tag}
                      </cf-cell-link>
                      <span
                        style={{
                          color: "var(--cf-theme-color-text-secondary)",
                        }}
                      >
                        {element.userTags.map((tag) => `#${tag}`).join(" ")}
                      </span>
                      <cf-button
                        size="sm"
                        variant="ghost"
                        onClick={mutateElements({
                          elements,
                          mode: "remove",
                          cell: element.cell,
                        })}
                      >
                        Remove
                      </cf-button>
                    </cf-hstack>
                  ))}
                </cf-vstack>

                <cf-hstack>
                  <cf-button
                    variant="ghost"
                    size="sm"
                    onClick={toggleProfileEditing({ editing })}
                  >
                    Done
                  </cf-button>
                </cf-hstack>
              </cf-vstack>,
              null,
            )}
          </cf-vstack>
        </cf-screen>
      ),
    };
  },
);
