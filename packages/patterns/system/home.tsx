/// <cts-enable />
import {
  computed,
  equals,
  handler,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";
import FavoritesManager from "./favorites-manager.tsx";
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

export default pattern((_) => {
  // OWN the data cells (.for for id stability)
  const favorites = Writable.of<Favorite[]>([]).for("favorites");
  const journal = Writable.of<JournalEntry[]>([]).for("journal");
  const learned = Writable.of<LearnedSection>(EMPTY_LEARNED).for("learned");
  const spaces = Writable.of<SpaceEntry[]>([]).for("spaces");
  const defaultAppUrl = Writable.of("").for("defaultAppUrl");

  // Child components
  const favoritesComponent = FavoritesManager({});
  const activeTab = Writable.of("spaces").for("activeTab");

  return {
    [NAME]: `Home`,
    [UI]: (
      <ct-screen>
        <h1>
          home<strong>space</strong>
        </h1>

        <ct-tabs $value={activeTab}>
          <ct-tab-list>
            <ct-tab value="spaces">Spaces</ct-tab>
            <ct-tab value="favorites">Favorites</ct-tab>
            <ct-tab value="profile">Profile</ct-tab>
          </ct-tab-list>
          <ct-tab-panel value="favorites">{favoritesComponent}</ct-tab-panel>
          <ct-tab-panel value="profile">
            <ct-vstack gap="4" style={{ padding: "1rem" }}>
              <h2 style={{ margin: 0, fontSize: "16px" }}>Profile Summary</h2>

              <ct-vstack gap="1">
                <ct-textarea
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
              </ct-vstack>
            </ct-vstack>
          </ct-tab-panel>
          <ct-tab-panel value="spaces">
            <ct-vstack gap="4" style={{ padding: "1rem" }}>
              <h2 style={{ margin: 0, fontSize: "16px" }}>My Spaces</h2>

              <ct-vstack gap="2">
                {spaces.map((space) => (
                  <ct-hstack gap="2" align="center">
                    <div style={{ flex: "1" }}>
                      <ct-space-link
                        spaceName={space.name}
                        spaceDid={space.did}
                      />
                    </div>
                    <ct-button
                      size="sm"
                      variant="ghost"
                      onClick={removeSpaceHandler({ name: space.name, spaces })}
                    >
                      ✕
                    </ct-button>
                  </ct-hstack>
                ))}
                {computed(() => spaces.get().length === 0) && (
                  <p
                    style={{
                      color: "#888",
                      fontStyle: "italic",
                      textAlign: "center",
                    }}
                  >
                    No spaces yet. Add one below.
                  </p>
                )}
              </ct-vstack>

              <hr style={{ border: "none", borderTop: "1px solid #e5e5e7" }} />

              <ct-vstack gap="1">
                <h3 style={{ margin: 0, fontSize: "14px" }}>
                  Add or Create Space
                </h3>
                <ct-message-input
                  placeholder="Space name..."
                  appearance="rounded"
                  onct-send={addSpaceHandler({ spaces })}
                />
                <span style={{ fontSize: "11px", color: "#888" }}>
                  Type a name and press enter. Click the link to navigate.
                </span>
              </ct-vstack>

              <hr
                style={{
                  border: "none",
                  borderTop: "1px solid #e5e5e7",
                  margin: "8px 0",
                }}
              />

              <ct-vstack gap="1">
                <h3 style={{ margin: 0, fontSize: "14px" }}>Settings</h3>
                <label style={{ fontSize: "13px", color: "#666" }}>
                  Default App Pattern URL
                </label>
                <ct-input
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
              </ct-vstack>
            </ct-vstack>
          </ct-tab-panel>
        </ct-tabs>
      </ct-screen>
    ),

    // Exported data
    favorites,
    journal,
    learned,
    spaces,
    defaultAppUrl,

    // Exported handlers
    addFavorite: addFavorite({ favorites }),
    removeFavorite: removeFavorite({ favorites }),
    addJournalEntry: addJournalEntry({ journal }),
  };
});
