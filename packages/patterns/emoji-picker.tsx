/// <cts-enable />
/**
 * Emoji Picker Pattern - Reusable pattern for emoji selection
 *
 * A composable pattern that can be used standalone or embedded in other patterns.
 * Uses ct-autocomplete for efficient searching through emojis.
 *
 * Usage:
 *   import EmojiPicker from "./emoji-picker.tsx";
 *   const picker = EmojiPicker({ selectedEmoji: myEmojiCell });
 */
import {
  type Cell,
  computed,
  type Default,
  handler,
  NAME,
  recipe,
  UI,
} from "commontools";
import type { ModuleMetadata } from "./container-protocol.ts";

// ===== Self-Describing Metadata =====
export const MODULE_METADATA: ModuleMetadata = {
  type: "emoji-picker",
  label: "Emoji Picker",
  icon: "\u{1F600}", // 😀
  internal: true, // Usually embedded, not added directly to records
  schema: {
    selectedEmoji: { type: "string", description: "Selected emoji character" },
  },
  fieldMapping: ["selectedEmoji"],
};

// ===== Types =====
export interface EmojiPickerInput {
  /** Currently selected emoji */
  selectedEmoji: Default<string, "">;
}

// ===== Emoji Data for ct-autocomplete =====
// Each emoji has a descriptive label and search aliases for discoverability
interface AutocompleteItem {
  value: string;
  label: string;
  group?: string;
  searchAliases?: string[];
}

// Build autocomplete items with good labels and search terms
const EMOJI_ITEMS: AutocompleteItem[] = [
  // Smileys & Emotion
  { value: "\u{1F600}", label: "\u{1F600} Grinning Face", group: "Smileys", searchAliases: ["grin", "happy", "smile", "face", "joy"] },
  { value: "\u{1F603}", label: "\u{1F603} Smiling Face with Open Mouth", group: "Smileys", searchAliases: ["happy", "smile", "face", "joy", "open"] },
  { value: "\u{1F604}", label: "\u{1F604} Smiling Face with Smiling Eyes", group: "Smileys", searchAliases: ["happy", "smile", "face", "laugh", "eyes"] },
  { value: "\u{1F601}", label: "\u{1F601} Beaming Face", group: "Smileys", searchAliases: ["grin", "happy", "smile", "beam", "teeth"] },
  { value: "\u{1F60A}", label: "\u{1F60A} Smiling Face with Blush", group: "Smileys", searchAliases: ["blush", "happy", "smile", "shy", "cute"] },
  { value: "\u{1F60D}", label: "\u{1F60D} Heart Eyes", group: "Smileys", searchAliases: ["love", "heart", "eyes", "face", "adore", "crush"] },
  { value: "\u{1F618}", label: "\u{1F618} Kissing Face with Heart", group: "Smileys", searchAliases: ["kiss", "love", "heart", "face", "blow kiss"] },
  { value: "\u{1F970}", label: "\u{1F970} Smiling Face with Hearts", group: "Smileys", searchAliases: ["love", "hearts", "face", "adore", "infatuated"] },
  { value: "\u{1F60E}", label: "\u{1F60E} Smiling Face with Sunglasses", group: "Smileys", searchAliases: ["cool", "sunglasses", "face", "awesome", "chill"] },
  { value: "\u{1F917}", label: "\u{1F917} Hugging Face", group: "Smileys", searchAliases: ["hug", "hands", "face", "warm", "embrace"] },
  { value: "\u{1F914}", label: "\u{1F914} Thinking Face", group: "Smileys", searchAliases: ["think", "hmm", "face", "ponder", "consider", "wondering"] },
  { value: "\u{1F644}", label: "\u{1F644} Eye Roll", group: "Smileys", searchAliases: ["eye", "roll", "face", "annoyed", "whatever", "sarcasm"] },
  { value: "\u{1F612}", label: "\u{1F612} Unamused Face", group: "Smileys", searchAliases: ["unamused", "face", "meh", "bored", "annoyed"] },
  { value: "\u{1F62D}", label: "\u{1F62D} Loudly Crying Face", group: "Smileys", searchAliases: ["cry", "sad", "tears", "face", "sobbing", "upset"] },
  { value: "\u{1F621}", label: "\u{1F621} Angry Face", group: "Smileys", searchAliases: ["angry", "mad", "face", "rage", "furious", "upset"] },
  { value: "\u{1F622}", label: "\u{1F622} Crying Face", group: "Smileys", searchAliases: ["cry", "sad", "tear", "face", "upset"] },
  { value: "\u{1F609}", label: "\u{1F609} Winking Face", group: "Smileys", searchAliases: ["wink", "face", "flirt", "playful", "joke"] },
  { value: "\u{1F92F}", label: "\u{1F92F} Mind Blown", group: "Smileys", searchAliases: ["mind", "blown", "explode", "shocked", "amazed", "wow"] },

  // People
  { value: "\u{1F464}", label: "\u{1F464} Person Silhouette", group: "People", searchAliases: ["person", "user", "silhouette", "profile", "account", "avatar"] },
  { value: "\u{1F465}", label: "\u{1F465} People", group: "People", searchAliases: ["people", "users", "group", "team", "community", "crowd"] },
  { value: "\u{1F46A}", label: "\u{1F46A} Family", group: "People", searchAliases: ["family", "people", "home", "parents", "children", "household"] },
  { value: "\u{1F468}", label: "\u{1F468} Man", group: "People", searchAliases: ["man", "person", "male", "guy", "gentleman", "adult"] },
  { value: "\u{1F469}", label: "\u{1F469} Woman", group: "People", searchAliases: ["woman", "person", "female", "lady", "girl", "adult"] },
  { value: "\u{1F476}", label: "\u{1F476} Baby", group: "People", searchAliases: ["baby", "child", "kid", "infant", "newborn", "toddler"] },

  // Animals
  { value: "\u{1F436}", label: "\u{1F436} Dog Face", group: "Animals", searchAliases: ["dog", "pet", "animal", "puppy", "canine", "pup", "doggy"] },
  { value: "\u{1F431}", label: "\u{1F431} Cat Face", group: "Animals", searchAliases: ["cat", "pet", "animal", "kitty", "kitten", "feline", "meow"] },
  { value: "\u{1F43B}", label: "\u{1F43B} Bear", group: "Animals", searchAliases: ["bear", "animal", "teddy", "grizzly", "wild"] },
  { value: "\u{1F981}", label: "\u{1F981} Lion", group: "Animals", searchAliases: ["lion", "animal", "king", "cat", "wild", "safari", "jungle"] },
  { value: "\u{1F984}", label: "\u{1F984} Unicorn", group: "Animals", searchAliases: ["unicorn", "magic", "horse", "fantasy", "mythical", "rainbow"] },
  { value: "\u{1F98B}", label: "\u{1F98B} Butterfly", group: "Animals", searchAliases: ["butterfly", "insect", "nature", "spring", "beautiful", "transform"] },
  { value: "\u{1F426}", label: "\u{1F426} Bird", group: "Animals", searchAliases: ["bird", "animal", "fly", "tweet", "wings", "feather"] },
  { value: "\u{1F420}", label: "\u{1F420} Tropical Fish", group: "Animals", searchAliases: ["fish", "animal", "sea", "tropical", "ocean", "aquarium", "nemo"] },

  // Nature
  { value: "\u{1F338}", label: "\u{1F338} Cherry Blossom", group: "Nature", searchAliases: ["flower", "cherry", "blossom", "spring", "pink", "sakura", "japan"] },
  { value: "\u{1F33B}", label: "\u{1F33B} Sunflower", group: "Nature", searchAliases: ["sunflower", "flower", "sun", "yellow", "summer", "bright"] },
  { value: "\u{1F332}", label: "\u{1F332} Evergreen Tree", group: "Nature", searchAliases: ["tree", "evergreen", "nature", "forest", "pine", "christmas"] },
  { value: "\u{1F335}", label: "\u{1F335} Cactus", group: "Nature", searchAliases: ["cactus", "plant", "desert", "succulent", "green", "prickly"] },
  { value: "\u{1F340}", label: "\u{1F340} Four Leaf Clover", group: "Nature", searchAliases: ["clover", "luck", "four", "leaf", "lucky", "irish", "fortune"] },
  { value: "\u{1F30E}", label: "\u{1F30E} Globe Americas", group: "Nature", searchAliases: ["earth", "world", "globe", "planet", "america", "international"] },
  { value: "\u{2600}\u{FE0F}", label: "\u{2600}\u{FE0F} Sun", group: "Nature", searchAliases: ["sun", "sunny", "weather", "bright", "summer", "hot", "day"] },
  { value: "\u{1F319}", label: "\u{1F319} Crescent Moon", group: "Nature", searchAliases: ["moon", "night", "crescent", "sleep", "dark", "evening"] },

  // Food
  { value: "\u{1F34E}", label: "\u{1F34E} Red Apple", group: "Food", searchAliases: ["apple", "fruit", "red", "food", "healthy", "teacher"] },
  { value: "\u{1F34C}", label: "\u{1F34C} Banana", group: "Food", searchAliases: ["banana", "fruit", "yellow", "food", "healthy", "potassium"] },
  { value: "\u{1F347}", label: "\u{1F347} Grapes", group: "Food", searchAliases: ["grape", "fruit", "purple", "food", "wine", "vineyard"] },
  { value: "\u{1F353}", label: "\u{1F353} Strawberry", group: "Food", searchAliases: ["strawberry", "fruit", "red", "food", "berry", "sweet"] },
  { value: "\u{1F354}", label: "\u{1F354} Hamburger", group: "Food", searchAliases: ["burger", "hamburger", "food", "fast", "lunch", "dinner", "beef"] },
  { value: "\u{1F355}", label: "\u{1F355} Pizza", group: "Food", searchAliases: ["pizza", "food", "italian", "slice", "cheese", "dinner", "party"] },
  { value: "\u{1F35F}", label: "\u{1F35F} French Fries", group: "Food", searchAliases: ["fries", "food", "fast", "french", "potato", "snack"] },
  { value: "\u{1F370}", label: "\u{1F370} Cake Slice", group: "Food", searchAliases: ["cake", "dessert", "sweet", "food", "slice", "treat"] },
  { value: "\u{1F382}", label: "\u{1F382} Birthday Cake", group: "Food", searchAliases: ["birthday", "cake", "celebration", "party", "candles", "wish"] },
  { value: "\u{1F37D}\u{FE0F}", label: "\u{1F37D}\u{FE0F} Plate with Cutlery", group: "Food", searchAliases: ["plate", "food", "dining", "eat", "dinner", "restaurant", "meal"] },
  { value: "\u{1F373}", label: "\u{1F373} Cooking Egg", group: "Food", searchAliases: ["egg", "cooking", "frying", "breakfast", "pan", "chef"] },

  // Activities & Sports
  { value: "\u{26BD}", label: "\u{26BD} Soccer Ball", group: "Activities", searchAliases: ["soccer", "football", "ball", "sport", "game", "goal"] },
  { value: "\u{1F3C0}", label: "\u{1F3C0} Basketball", group: "Activities", searchAliases: ["basketball", "ball", "sport", "hoop", "nba", "game"] },
  { value: "\u{1F3C8}", label: "\u{1F3C8} American Football", group: "Activities", searchAliases: ["football", "american", "sport", "ball", "nfl", "touchdown"] },
  { value: "\u{1F3BE}", label: "\u{1F3BE} Tennis", group: "Activities", searchAliases: ["tennis", "sport", "ball", "racket", "game", "court"] },
  { value: "\u{1F3C6}", label: "\u{1F3C6} Trophy", group: "Activities", searchAliases: ["trophy", "winner", "award", "gold", "champion", "first", "prize"] },
  { value: "\u{1F3A8}", label: "\u{1F3A8} Artist Palette", group: "Activities", searchAliases: ["art", "palette", "paint", "creative", "artist", "design", "color"] },
  { value: "\u{1F3B5}", label: "\u{1F3B5} Musical Note", group: "Activities", searchAliases: ["music", "note", "song", "sound", "melody", "tune", "audio"] },
  { value: "\u{1F3B8}", label: "\u{1F3B8} Guitar", group: "Activities", searchAliases: ["guitar", "music", "rock", "instrument", "band", "play"] },
  { value: "\u{1F3AC}", label: "\u{1F3AC} Clapper Board", group: "Activities", searchAliases: ["movie", "film", "clapboard", "cinema", "video", "action", "hollywood"] },
  { value: "\u{1F3AE}", label: "\u{1F3AE} Video Game Controller", group: "Activities", searchAliases: ["game", "video", "controller", "play", "gaming", "console", "xbox", "playstation"] },

  // Objects & Tech
  { value: "\u{1F4BB}", label: "\u{1F4BB} Laptop", group: "Tech", searchAliases: ["laptop", "computer", "tech", "work", "coding", "macbook", "pc"] },
  { value: "\u{1F4F1}", label: "\u{1F4F1} Mobile Phone", group: "Tech", searchAliases: ["phone", "mobile", "cell", "device", "iphone", "android", "smartphone"] },
  { value: "\u{1F4F7}", label: "\u{1F4F7} Camera", group: "Tech", searchAliases: ["camera", "photo", "picture", "photography", "snapshot", "image"] },
  { value: "\u{1F4A1}", label: "\u{1F4A1} Light Bulb", group: "Tech", searchAliases: ["lightbulb", "idea", "light", "bright", "inspiration", "think", "innovation"] },
  { value: "\u{1F50B}", label: "\u{1F50B} Battery", group: "Tech", searchAliases: ["battery", "power", "energy", "charge", "full", "electric"] },
  { value: "\u{1F4DA}", label: "\u{1F4DA} Books", group: "Objects", searchAliases: ["books", "reading", "library", "study", "learn", "education", "knowledge"] },
  { value: "\u{1F4DD}", label: "\u{1F4DD} Memo", group: "Objects", searchAliases: ["memo", "note", "write", "pencil", "document", "paper", "list"] },
  { value: "\u{1F4CB}", label: "\u{1F4CB} Clipboard", group: "Objects", searchAliases: ["clipboard", "list", "document", "record", "tasks", "checklist"] },
  { value: "\u{1F4BC}", label: "\u{1F4BC} Briefcase", group: "Objects", searchAliases: ["briefcase", "work", "business", "job", "office", "professional"] },
  { value: "\u{1F3E0}", label: "\u{1F3E0} House", group: "Objects", searchAliases: ["house", "home", "building", "residence", "family", "property"] },
  { value: "\u{1F3E2}", label: "\u{1F3E2} Office Building", group: "Objects", searchAliases: ["office", "building", "work", "business", "corporate", "company"] },
  { value: "\u{1F512}", label: "\u{1F512} Lock", group: "Objects", searchAliases: ["lock", "secure", "private", "closed", "security", "password", "protected"] },
  { value: "\u{1F511}", label: "\u{1F511} Key", group: "Objects", searchAliases: ["key", "unlock", "password", "access", "open", "secret"] },
  { value: "\u{1F527}", label: "\u{1F527} Wrench", group: "Objects", searchAliases: ["wrench", "tool", "fix", "settings", "repair", "mechanic"] },
  { value: "\u{2699}\u{FE0F}", label: "\u{2699}\u{FE0F} Gear", group: "Objects", searchAliases: ["gear", "settings", "cog", "config", "options", "preferences"] },

  // Symbols & Hearts
  { value: "\u{2764}\u{FE0F}", label: "\u{2764}\u{FE0F} Red Heart", group: "Symbols", searchAliases: ["heart", "love", "red", "like", "romance", "favorite"] },
  { value: "\u{1F499}", label: "\u{1F499} Blue Heart", group: "Symbols", searchAliases: ["heart", "blue", "love", "trust", "calm"] },
  { value: "\u{1F49A}", label: "\u{1F49A} Green Heart", group: "Symbols", searchAliases: ["heart", "green", "love", "nature", "health", "eco"] },
  { value: "\u{1F49B}", label: "\u{1F49B} Yellow Heart", group: "Symbols", searchAliases: ["heart", "yellow", "love", "friendship", "happy", "sunshine"] },
  { value: "\u{1F49C}", label: "\u{1F49C} Purple Heart", group: "Symbols", searchAliases: ["heart", "purple", "love", "compassion", "honor"] },
  { value: "\u{2B50}", label: "\u{2B50} Star", group: "Symbols", searchAliases: ["star", "favorite", "gold", "rating", "best", "excellent", "bookmark"] },
  { value: "\u{1F31F}", label: "\u{1F31F} Glowing Star", group: "Symbols", searchAliases: ["star", "glow", "sparkle", "shine", "special", "magic"] },
  { value: "\u{2728}", label: "\u{2728} Sparkles", group: "Symbols", searchAliases: ["sparkle", "magic", "shine", "new", "clean", "glitter", "special"] },
  { value: "\u{1F525}", label: "\u{1F525} Fire", group: "Symbols", searchAliases: ["fire", "hot", "flame", "lit", "trending", "awesome", "burn"] },
  { value: "\u{1F4A5}", label: "\u{1F4A5} Collision", group: "Symbols", searchAliases: ["boom", "explosion", "collision", "impact", "crash", "pow"] },
  { value: "\u{2705}", label: "\u{2705} Check Mark", group: "Symbols", searchAliases: ["check", "done", "yes", "complete", "correct", "approved", "success"] },
  { value: "\u{274C}", label: "\u{274C} Cross Mark", group: "Symbols", searchAliases: ["cross", "no", "wrong", "delete", "cancel", "error", "fail"] },
  { value: "\u{2757}", label: "\u{2757} Exclamation Mark", group: "Symbols", searchAliases: ["exclamation", "important", "alert", "warning", "attention", "urgent"] },
  { value: "\u{2753}", label: "\u{2753} Question Mark", group: "Symbols", searchAliases: ["question", "help", "what", "unknown", "confused", "ask"] },

  // Travel & Places
  { value: "\u{1F697}", label: "\u{1F697} Car", group: "Travel", searchAliases: ["car", "vehicle", "drive", "auto", "road", "trip", "transportation"] },
  { value: "\u{2708}\u{FE0F}", label: "\u{2708}\u{FE0F} Airplane", group: "Travel", searchAliases: ["plane", "airplane", "fly", "travel", "flight", "vacation", "trip"] },
  { value: "\u{1F680}", label: "\u{1F680} Rocket", group: "Travel", searchAliases: ["rocket", "space", "launch", "fast", "startup", "moon", "ship"] },
  { value: "\u{1F3D6}\u{FE0F}", label: "\u{1F3D6}\u{FE0F} Beach with Umbrella", group: "Travel", searchAliases: ["beach", "vacation", "island", "umbrella", "summer", "holiday", "relax"] },
  { value: "\u{1F30D}", label: "\u{1F30D} Globe Europe-Africa", group: "Travel", searchAliases: ["earth", "globe", "world", "europe", "africa", "international"] },
  { value: "\u{1F5FA}\u{FE0F}", label: "\u{1F5FA}\u{FE0F} World Map", group: "Travel", searchAliases: ["map", "world", "location", "geography", "travel", "explore"] },
  { value: "\u{1F4CD}", label: "\u{1F4CD} Location Pin", group: "Travel", searchAliases: ["pin", "location", "map", "place", "marker", "here", "address"] },
];

// ===== Handlers =====

// Handler for ct-autocomplete's ct-select event
const onSelectEmoji = handler<
  CustomEvent<{ value: string; label: string }>,
  { selectedEmoji: Cell<string> }
>((event, { selectedEmoji }) => {
  const { value } = event.detail;
  selectedEmoji.set(value);
});

const clearSelection = handler<unknown, { selectedEmoji: Cell<string> }>(
  (_event, { selectedEmoji }) => {
    selectedEmoji.set("");
  },
);

// ===== The Pattern =====
export const EmojiPicker = recipe<EmojiPickerInput, EmojiPickerInput>(
  "EmojiPicker",
  ({ selectedEmoji }) => {
    // Display text for NAME
    const displayText = computed(() =>
      selectedEmoji ? `Selected: ${selectedEmoji}` : "None"
    );

    return {
      [NAME]: computed(() => `${MODULE_METADATA.icon} Emoji: ${displayText}`),
      [UI]: (
        <ct-vstack style={{ gap: "8px" }}>
          {/* Current selection display */}
          <ct-hstack style={{ gap: "8px", alignItems: "center" }}>
            <div
              style={{
                fontSize: "32px",
                lineHeight: "1",
                minWidth: "40px",
                textAlign: "center",
              }}
            >
              {selectedEmoji || "\u{2754}"}
            </div>
            <ct-autocomplete
              items={EMOJI_ITEMS}
              placeholder="Search emojis..."
              onct-select={onSelectEmoji({ selectedEmoji })}
              style={{ flex: "1" }}
            />
            <ct-button onClick={clearSelection({ selectedEmoji })}>
              Clear
            </ct-button>
          </ct-hstack>

          {/* Help text */}
          <span style={{ fontSize: "11px", color: "#9ca3af" }}>
            {computed(() =>
              selectedEmoji
                ? `Current: ${selectedEmoji}`
                : "Type to search emojis by name or keyword"
            )}
          </span>
        </ct-vstack>
      ),
      selectedEmoji,
    };
  },
);

export default EmojiPicker;
