import {
  computed,
  equals,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
} from "commonfabric";

type ProfileElementCell = {
  [NAME]?: string;
};

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
  name: string;
};

export type SetProfileAvatarEvent = {
  avatar: string;
};

export type ProfileHomeOutput = {
  [NAME]: string;
  [UI]: unknown;
  name: string;
  avatar: string;
  elements: ProfileElement[];
  setName: Stream<SetProfileNameEvent>;
  setAvatar: Stream<SetProfileAvatarEvent>;
  addElement: Stream<AddProfileElementEvent>;
  removeElement: Stream<RemoveProfileElementEvent>;
};

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
  (event, state) => state.name.set(event.name),
);

const setAvatar = handler<SetProfileAvatarEvent, { avatar: Writable<string> }>(
  (event, state) => state.avatar.set(event.avatar),
);

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

export default pattern<Record<string, never>, ProfileHomeOutput>(() => {
  const name = new Writable("").for("name");
  const avatar = new Writable("").for("avatar");
  const elements = new Writable<ProfileElement[]>([]).for("elements");
  const patternUrl = new Writable("").for("patternUrl");
  const elementTitle = new Writable("").for("elementTitle");
  const elementTag = new Writable("").for("elementTag");
  const userTagsText = new Writable("").for("userTagsText");

  const parsedUserTags = computed(() =>
    userTagsText.get().split(",").map((tag) => tag.trim()).filter((tag) =>
      tag.length > 0
    )
  );

  return {
    [NAME]: "Profile",
    name,
    avatar,
    elements,
    setName: setName({ name }),
    setAvatar: setAvatar({ avatar }),
    addElement: addElement({ elements }),
    removeElement: removeElement({ elements }),
    [UI]: (
      <cf-screen>
        <cf-toolbar slot="header" sticky>
          <div slot="start">
            <h2 style={{ margin: 0, fontSize: "18px" }}>Profile</h2>
          </div>
        </cf-toolbar>

        <cf-vstack gap="4" style={{ padding: "16px", maxWidth: "720px" }}>
          <cf-vstack gap="2">
            <label>Name</label>
            <cf-input $value={name} placeholder="Your name" />
          </cf-vstack>

          <cf-vstack gap="2">
            <label>Avatar</label>
            <cf-input $value={avatar} placeholder="Avatar URL or text" />
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
                  onClick={removeElementCell({ elements, cell: element.cell })}
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
});
