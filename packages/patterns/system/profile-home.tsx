import {
  Cfc,
  computed,
  equals,
  handler,
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
  elements: OwnerProtectedProfileWrite<ProfileElement[], typeof addElement>;
  setName: Stream<SetProfileNameEvent>;
  setAvatar: Stream<SetProfileAvatarEvent>;
  addElement: Stream<AddProfileElementEvent>;
  removeElement: Stream<RemoveProfileElementEvent>;
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
        <span style={{ color: "var(--cf-color-text-secondary)" }}>{url}</span>
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

const addElement = handler<
  AddProfileElementEvent,
  { elements: Writable<ProfileElement[]> }
>((event, { elements }) => {
  const source = event.patternUrl ? "url" : "catalog";
  const title = event.title ??
    (source === "url" ? event.patternUrl ?? "Profile pattern" : "Profile card");
  const tag = event.tag ?? event.catalogId ?? event.patternUrl ?? "profile";
  const cell = source === "url"
    ? (UrlPatternReference({ title, url: event.patternUrl ?? "" }) as any).for(
      tag,
    )
    : (ProfileCatalogCard({ title }) as any).for(tag);
  appendElement({
    cell,
    tag,
    userTags: event.userTags ?? [],
    title,
    source,
  }, elements);
});

const removeElement = handler<
  RemoveProfileElementEvent,
  { elements: Writable<ProfileElement[]> }
>(({ cell }, { elements }) => {
  elements.set(
    elements.get().filter((element) => !equals(element.cell, cell)),
  );
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

const applyInitialName = lift<
  { initialName?: string; name: Writable<string> },
  string
>(({ initialName, name }) => {
  return name.get() ?? trimInitialName(initialName);
});

const addCatalogElement = handler<void, {
  elements: Writable<ProfileElement[]>;
  userTags: string[];
}>((_, state) => {
  appendElement({
    cell: (ProfileCatalogCard({ title: "Profile card" }) as any).for(
      "profile-card",
    ),
    source: "catalog",
    title: "Profile card",
    tag: "profile-card",
    userTags: state.userTags,
  }, state.elements);
});

const addUrlElement = handler<void, {
  elements: Writable<ProfileElement[]>;
  patternUrl: Writable<string>;
  title: Writable<string>;
  tag: Writable<string>;
  userTags: string[];
}>((_, state) => {
  const url = state.patternUrl.get().trim();
  if (!url) {
    return;
  }
  const title = state.title.get().trim() || url;
  const tag = state.tag.get().trim() || url;
  appendElement({
    cell: (UrlPatternReference({ title, url }) as any).for(tag),
    source: "url",
    title,
    tag,
    userTags: state.userTags,
  }, state.elements);
  state.patternUrl.set("");
  state.title.set("");
  state.tag.set("");
});

const removeElementCell = handler<void, {
  elements: Writable<ProfileElement[]>;
  cell: any;
}>((_, state) => {
  state.elements.set(
    state.elements.get().filter((element) => !equals(element.cell, state.cell)),
  );
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
      OwnerProtectedProfileWrite<ProfileElement[], typeof addElement>
    >([]).for("elements");
    const patternUrl = new Writable("").for("patternUrl");
    const elementTitle = new Writable("").for("elementTitle");
    const elementTag = new Writable("").for("elementTag");
    const userTagsText = new Writable("").for("userTagsText");

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
      addElement: addElement({ elements }),
      removeElement: removeElement({ elements }),
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
                onClick={addCatalogElement({
                  elements,
                  userTags: parsedUserTags,
                })}
              >
                Add profile card
              </cf-button>
            </cf-hstack>

            <cf-vstack gap="2">
              <label>Pattern URL</label>
              <cf-input $value={patternUrl} placeholder="/api/patterns/..." />
              <cf-input $value={elementTitle} placeholder="Title" />
              <cf-input $value={elementTag} placeholder="Tag" />
              <cf-button
                onClick={addUrlElement({
                  elements,
                  patternUrl,
                  title: elementTitle,
                  tag: elementTag,
                  userTags: parsedUserTags,
                })}
              >
                Add URL element
              </cf-button>
            </cf-vstack>

            <cf-vstack gap="2">
              {elements.map((element) => (
                <cf-hstack gap="2" align="center">
                  <cf-cell-link $cell={element.cell}>
                    {element.title ?? element.tag}
                  </cf-cell-link>
                  <span style={{ color: "var(--cf-color-text-secondary)" }}>
                    {element.userTags.map((tag) => `#${tag}`).join(" ")}
                  </span>
                  <cf-button
                    size="sm"
                    variant="ghost"
                    onClick={removeElementCell({
                      elements,
                      cell: element.cell,
                    })}
                  >
                    Remove
                  </cf-button>
                </cf-hstack>
              ))}
            </cf-vstack>
          </cf-vstack>
        </cf-screen>
      ),
    };
  },
);
