import {
  computed,
  equals,
  handler,
  lift,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
} from "commonfabric";
import FavoritesManager from "./favorites-manager.tsx";
import ProfileHome, { type ProfileHomeOutput } from "./profile-home.tsx";
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

type CreateProfileEvent = {
  detail?: { message?: string };
  name?: string;
};

type HomeOutput = {
  [NAME]: string;
  [UI]: unknown;
  favorites: Writable<Favorite[]>;
  journal: Writable<JournalEntry[]>;
  learned: Writable<LearnedSection>;
  spaces: Writable<SpaceEntry[]>;
  defaultAppUrl: Writable<string>;
  profile?: ProfileHomeOutput;
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

const requestProfileCreation = handler<
  CreateProfileEvent,
  { requestedProfileName: Writable<string> }
>((event, { requestedProfileName }) => {
  const name = (event.name ?? event.detail?.message ?? "").trim();
  if (name) {
    requestedProfileName.set(name);
  }
});

const createProfileFromName = lift<
  { name: string },
  ProfileHomeOutput | undefined
>(({ name }) => {
  const trimmed = name.trim();
  if (!trimmed) {
    return undefined;
  }
  return ProfileHome.inSpace(trimmed)({ initialName: trimmed });
});

export default pattern<Record<string, never>, HomeOutput>((_) => {
  // OWN the data cells (.for for id stability)
  const favorites = new Writable<Favorite[]>([]).for("favorites");
  const journal = new Writable<JournalEntry[]>([]).for("journal");
  const learned = new Writable<LearnedSection>(EMPTY_LEARNED).for("learned");
  const spaces = new Writable<SpaceEntry[]>([]).for("spaces");
  const defaultAppUrl = new Writable("").for("defaultAppUrl");
  const requestedProfileName = new Writable("").for("requestedProfileName");
  const profile = createProfileFromName({ name: requestedProfileName });

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

              {profile
                ? (
                  <cf-vstack gap="2">
                    <cf-hstack gap="2" align="center">
                      <strong>{profile.name}</strong>
                      <span style={{ color: "#888" }}>{profile.avatar}</span>
                    </cf-hstack>
                    <cf-render $cell={profile as any} />
                  </cf-vstack>
                )
                : (
                  <cf-vstack gap="1">
                    <cf-message-input
                      placeholder="Your name..."
                      appearance="rounded"
                      oncf-send={requestProfileCreation({
                        requestedProfileName,
                      })}
                    />
                  </cf-vstack>
                )}
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

    // Exported handlers
    addFavorite: addFavorite({ favorites }),
    removeFavorite: removeFavorite({ favorites }),
    addJournalEntry: addJournalEntry({ journal }),
    createProfile: requestProfileCreation({ requestedProfileName }),
  };
});
