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

// THE single authorized writer for the owner-protected `elements` list. A
// `writeAuthorizedBy` claim carries exactly one handler binding, verified
// against the writing handler's implementation identity — so every element
// mutation (the exported add/remove streams, the catalog/link-form buttons,
// the per-row remove) must be an INSTANCE of this one implementation.
// Instances differ only in bound state, which doesn't change the
// implementation identity.
const mutateElements = handler<
  MutateProfileElementsEvent,
  {
    elements: Writable<ProfileElement[]>;
    // Per-row remove binding: when set, this instance removes that element.
    cell?: any;
    // Link form binding: when bound and the event carries no explicit
    // patternUrl, the URL/title/tag are read from (and cleared on) the form.
    patternUrl?: Writable<string>;
    title?: Writable<string>;
    tag?: Writable<string>;
    userTags?: string[];
  }
>((event, state) => {
  const removeCell = event.cell ?? state.cell;
  if (removeCell !== undefined) {
    state.elements.set(
      state.elements.get().filter((element) =>
        !equals(element.cell, removeCell)
      ),
    );
    return;
  }
  const eventUrl = (event.patternUrl ?? "").trim();
  const formUrl = eventUrl.length === 0
    ? (state.patternUrl?.get() ?? "").trim()
    : "";
  const url = eventUrl.length > 0 ? eventUrl : formUrl;
  if (url.length > 0) {
    const fromForm = eventUrl.length === 0;
    const title = (event.title ??
      (fromForm ? state.title?.get() : undefined))?.trim() ||
      url;
    const tag = (event.tag ??
      (fromForm ? state.tag?.get() : undefined))?.trim() ||
      url;
    appendElement({
      cell: (UrlPatternReference({ title, url }) as any).for(tag),
      source: "url",
      title,
      tag,
      userTags: event.userTags ?? state.userTags ?? [],
    }, state.elements);
    if (fromForm) {
      state.patternUrl?.set("");
      state.title?.set("");
      state.tag?.set("");
    }
    return;
  }
  const title = event.title ?? "Profile card";
  const tag = event.tag ?? event.catalogId ?? "profile-card";
  appendElement({
    cell: (ProfileCatalogCard({ title }) as any).for(tag),
    source: "catalog",
    title,
    tag,
    userTags: event.userTags ?? state.userTags ?? [],
  }, state.elements);
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
      // Both exported streams are instances of the one authorized writer.
      addElement: mutateElements({ elements }),
      removeElement: mutateElements({ elements }),
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
                onClick={mutateElements({
                  elements,
                  userTags: parsedUserTags,
                })}
              >
                Add profile card
              </cf-button>
            </cf-hstack>

            <cf-vstack gap="2">
              <label>Link URL</label>
              <cf-input $value={patternUrl} placeholder="/api/patterns/..." />
              <cf-input $value={elementTitle} placeholder="Title" />
              <cf-input $value={elementTag} placeholder="Tag" />
              <cf-button
                onClick={mutateElements({
                  elements,
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
                  <span style={{ color: "var(--cf-color-text-secondary)" }}>
                    {element.userTags.map((tag) => `#${tag}`).join(" ")}
                  </span>
                  <cf-button
                    size="sm"
                    variant="ghost"
                    onClick={mutateElements({
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
