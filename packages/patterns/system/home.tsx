import {
  computed,
  equals,
  handler,
  ifElse,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
} from "commonfabric";
import FavoritesManager from "./favorites-manager.tsx";
import ProfileCreate, {
  type CreateProfileEvent,
  submitProfileCreation,
  type TrustedProfileLink,
} from "./profile-create.tsx";
import { EMPTY_LEARNED, type LearnedSection } from "../profile.tsx";

// Types from favorites-manager.tsx
type Favorite = {
  cell: { [NAME]?: string };
  tag: string;
  userTags: string[];
  spaceName?: string;
  spaceDid?: string;
};

type JournalEntry = {
  timestamp?: number;
  eventType?: string;
  subject?: Writable<unknown>;
  snapshot?: { name?: string; schemaTag?: string; valueExcerpt?: string };
  narrative?: string;
  narrativePending?: boolean;
  tags?: string[];
  space?: string;
};

type SpaceEntry = {
  name: string;
  did?: string;
};

type HomeOutput = {
  [NAME]: string;
  [UI]: unknown;
  favorites: Writable<Favorite[]>;
  journal: Writable<JournalEntry[]>;
  learned: Writable<LearnedSection>;
  spaces: Writable<SpaceEntry[]>;
  defaultAppUrl: Writable<string>;
  profile?: TrustedProfileLink;
  createProfile: Stream<CreateProfileEvent>;
};

// Handler to add a favorite
const addFavorite = handler<
  { piece: Writable<{ [NAME]?: string }>; tag?: string; spaceName?: string },
  { favorites: Writable<Favorite[]> }
>(({ piece, tag, spaceName }, { favorites }) => {
  const current = favorites.get();
  if (!current.some((f) => f && equals(f.cell, piece))) {
    // HACK(seefeld): Access internal API to get schema.
    // Once we sandbox, we need proper reflection
    let schema = (piece as any)?.resolveAsCell()?.asSchema(undefined)
      .asSchemaFromLinks?.()?.schema;
    if (typeof schema !== "object") schema = "";

    const spaceDid = (piece as any)?.space as string | undefined;
    const schemaTag = tag || JSON.stringify(schema) || "";

    favorites.push({
      cell: piece,
      tag: schemaTag,
      userTags: [],
      spaceName,
      spaceDid,
    });
  }
});

// Handler to remove a favorite
const removeFavorite = handler<
  { piece: Writable<unknown> },
  { favorites: Writable<Favorite[]> }
>(({ piece }, { favorites }) => {
  const favorite = favorites.get().find((f) => f && equals(f.cell, piece));
  if (favorite) {
    favorites.remove(favorite);
  }
});

// Handler to add a journal entry (kept for schema compatibility)
const addJournalEntry = handler<
  { entry: JournalEntry },
  { journal: Writable<JournalEntry[]> }
>(({ entry }, { journal }) => {
  journal.push(entry);
});

// Handler to add a space to the managed list
const addSpaceHandler = handler<
  { detail: { message: string } },
  { spaces: Writable<SpaceEntry[]> }
>(({ detail }, { spaces }) => {
  const name = detail?.message?.trim();
  if (!name) return;
  const current = spaces.get();
  if (!current.some((s) => s.name === name)) {
    spaces.push({ name });
  }
});

// Handler to remove a space from the managed list
const removeSpaceHandler = handler<
  Record<string, never>,
  { name: string; spaces: Writable<SpaceEntry[]> }
>((_, { name, spaces }) => {
  const current = spaces.get();
  const filtered = current.filter((s) => s.name !== name);
  spaces.set(filtered);
});

export default pattern<Record<string, never>, HomeOutput>((_) => {
  // OWN the data cells (.for for id stability)
  const favorites = new Writable<Favorite[]>([]).for("favorites");
  const journal = new Writable<JournalEntry[]>([]).for("journal");
  const learned = new Writable<LearnedSection>(EMPTY_LEARNED).for("learned");
  const spaces = new Writable<SpaceEntry[]>([]).for("spaces");
  const defaultAppUrl = new Writable("").for("defaultAppUrl");
  // NOTE(CT-1628): the `as any` casts around `profile` below are required
  // because the CFC wrapper types (TrustedProfileLink) don't yet compose with
  // Writable/the pattern factory output type. Tracked for a proper type fix.
  const profile = new Writable<TrustedProfileLink>(undefined).for("profile");
  const profileName = new Writable("").for("profileName");
  const createProfileStream = submitProfileCreation({
    profile: profile as any,
    profileName,
  });
  // Pass the owner-protected `profile` cell (TrustedProfileLink IFC schema)
  // through unchanged: `profile.set(ProfileHome.inSpace(name)(...))` materializes
  // the cross-space `inSpace` child during the handler's own `.set()`, which the
  // runner now opts into a multi-space commit for (see data-updating.ts /
  // normalizeAndDiff). Keeping the schema preserves CFC owner-protection on the
  // home→profile link write. See docs/specs/shared-profile-space.md.
  const profileCreate = ProfileCreate({
    profile: profile as any,
    profileName,
    inputId: "home-profile-name-input",
    buttonId: "home-profile-create-button",
  });
  // Existence is keyed off the durable profile *link* (`profile`), which is the
  // source of truth; `profileName` is only a creation-latency fallback. The link
  // points cross-space (into the name-derived profile space), so on the first
  // render right after creation `profile.get()` is still `undefined` until that
  // space loads — but the home-space `profileName` mirror, written alongside the
  // link, reads immediately and covers that window. Keying primarily off the
  // link means a home whose link is populated but whose `profileName` mirror is
  // empty (e.g. a migrated/partially-populated home) still reports a profile and
  // does not re-show the create form (which would let it overwrite a valid
  // link). The `cf-render` below resolves and loads the cross-space profile for
  // display.
  const hasProfile = computed(() =>
    profile.get() !== undefined ||
    (profileName.get() ?? "").trim().length > 0
  );

  // Child components
  const favoritesComponent = FavoritesManager({});
  const activeTab = new Writable("spaces").for("activeTab");

  return {
    [NAME]: `Home`,
    [UI]: (
      <cf-screen>
        <h1>
          home<strong>space</strong>
        </h1>

        <cf-tabs $value={activeTab}>
          <cf-tab-list>
            <cf-tab value="spaces">Spaces</cf-tab>
            <cf-tab value="favorites">Favorites</cf-tab>
            <cf-tab value="profile">Profile</cf-tab>
          </cf-tab-list>
          <cf-tab-panel value="favorites">{favoritesComponent}</cf-tab-panel>
          <cf-tab-panel value="profile">
            <cf-vstack gap="4" style={{ padding: "1rem" }}>
              <h2 style={{ margin: 0, fontSize: "16px" }}>Profile</h2>

              {ifElse(
                hasProfile,
                (
                  <cf-vstack gap="2">
                    <cf-hstack id="home-profile-summary" gap="2" align="center">
                      {
                        /*
                        Show the home-space `profileName` mirror here rather than
                        `profile.key("name")`: the latter reads cross-space (into
                        the profile space) and renders empty inline. The live,
                        editable name is shown by the `cf-render` below.
                      */
                      }
                      <strong>{profileName}</strong>
                    </cf-hstack>
                    <cf-render $cell={profile as any} />
                  </cf-vstack>
                ),
                profileCreate,
              )}

              {
                /*
                Free-form summary lives on learned.summary, independent of the
                shared profile space. It is intentionally not resolved by the
                #profile wish (which targets the profile pattern).
              */
              }
              <cf-vstack gap="1">
                <h3 style={{ margin: 0, fontSize: "14px" }}>Profile Summary</h3>
                <cf-textarea
                  $value={learned.key("summary")}
                  placeholder="Write a short profile summary about yourself..."
                  rows={6}
                  style={{
                    width: "100%",
                    fontFamily: "system-ui, sans-serif",
                    fontSize: "14px",
                    lineHeight: "1.5",
                    padding: "12px",
                    border: "1px solid #e5e5e7",
                    borderRadius: "8px",
                    resize: "vertical",
                  }}
                />
                <span style={{ fontSize: "11px", color: "#888" }}>
                  Edit your profile summary above.
                </span>
              </cf-vstack>
            </cf-vstack>
          </cf-tab-panel>
          <cf-tab-panel value="spaces">
            <cf-vstack gap="4" style={{ padding: "1rem" }}>
              <h2 style={{ margin: 0, fontSize: "16px" }}>My Spaces</h2>

              <cf-vstack gap="2">
                {spaces.map((space) => (
                  <cf-hstack gap="2" align="center">
                    <div style={{ flex: "1" }}>
                      <cf-space-link
                        spaceName={space.name}
                        spaceDid={space.did}
                      />
                    </div>
                    <cf-button
                      size="sm"
                      variant="ghost"
                      onClick={removeSpaceHandler({ name: space.name, spaces })}
                    >
                      ✕
                    </cf-button>
                  </cf-hstack>
                ))}
                {computed(() => spaces.get().length === 0)
                  ? (
                    <p
                      style={{
                        color: "#888",
                        fontStyle: "italic",
                        textAlign: "center",
                      }}
                    >
                      No spaces yet. Add one below.
                    </p>
                  )
                  : null}
              </cf-vstack>

              <hr style={{ border: "none", borderTop: "1px solid #e5e5e7" }} />

              <cf-vstack gap="1">
                <h3 style={{ margin: 0, fontSize: "14px" }}>
                  Add or Create Space
                </h3>
                <cf-message-input
                  placeholder="Space name..."
                  appearance="rounded"
                  oncf-send={addSpaceHandler({ spaces })}
                />
                <span style={{ fontSize: "11px", color: "#888" }}>
                  Type a name and press enter. Click the link to navigate.
                </span>
              </cf-vstack>

              <hr
                style={{
                  border: "none",
                  borderTop: "1px solid #e5e5e7",
                  margin: "8px 0",
                }}
              />

              <cf-vstack gap="1">
                <h3 style={{ margin: 0, fontSize: "14px" }}>Settings</h3>
                <label style={{ fontSize: "13px", color: "#666" }}>
                  Default App Pattern URL
                </label>
                <cf-input
                  $value={defaultAppUrl}
                  placeholder="/api/patterns/system/default-app.tsx"
                  style={{
                    width: "100%",
                    fontFamily: "monospace",
                    fontSize: "12px",
                  }}
                />
                <span style={{ fontSize: "11px", color: "#888" }}>
                  Pattern URL for new spaces. Leave empty for system default.
                </span>
              </cf-vstack>
            </cf-vstack>
          </cf-tab-panel>
        </cf-tabs>
      </cf-screen>
    ),

    // Exported data
    favorites,
    journal,
    learned,
    spaces,
    defaultAppUrl,
    profile,
    // Exposed so #profileName can fall back to the name typed at creation while
    // the owner-protected profile link is still resolving (creation latency);
    // the live name comes from the profile's own `initialNameApplied`.
    profileName,

    // Exported handlers
    addFavorite: addFavorite({ favorites }),
    removeFavorite: removeFavorite({ favorites }),
    addJournalEntry: addJournalEntry({ journal }),
    createProfile: createProfileStream,
  };
});
