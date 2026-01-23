/// <cts-enable />
/**
 * Folksonomy Tags - Community-Enabled Tag List Sub-Pattern
 *
 * A folksonomy-enabled tag list that learns from collective usage.
 * Like Flickr tags (public, emergent ontology) rather than Gmail labels (private silos).
 *
 * FEATURES:
 * - Local-first autocomplete: Shows tags from user's space matching the same scope
 * - Community fallback: When no local matches, show dimmed suggestions from community
 * - Preferential attachment: Popular community tags sort first (most used -> least used)
 * - Telemetry: Posts add/use/remove events to community aggregator charm
 *
 * USAGE:
 * ```tsx
 * const tags = Writable.of<string[]>([]);
 * <ct-render $cell={FolksonomyTags({
 *   scope: "https://github.com/example/recipe-tracker",
 *   tags,
 * })} />
 * ```
 *
 * AGGREGATOR DISCOVERY:
 * This pattern auto-discovers the aggregator using wish("#folksonomy-aggregator").
 * Deploy and favorite the folksonomy-aggregator charm for community features.
 * Without the aggregator, falls back to local-only mode.
 */
import {
  type Default,
  derive,
  handler,
  lift,
  NAME,
  recipe,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commontools";

/**
 * Tag event sent to the aggregator.
 */
interface TagEvent {
  scope: string;
  tag: string;
  action: "add" | "use" | "remove";
  timestamp: number;
}

/**
 * Community tag suggestion from the aggregator.
 */
interface CommunityTagSuggestion {
  tag: string;
  count: number;
}

/**
 * Aggregator interface for type-safe wish().
 */
interface AggregatorCharm {
  postEvent: Stream<TagEvent>;
  suggestions: Record<string, CommunityTagSuggestion[]>;
}

interface FolksonomyTagsInput {
  /** Namespace key (e.g., GitHub URL of the pattern using it) */
  scope: Writable<Default<string, "">>;
  /** User's tags for this scope - bidirectional binding */
  tags: Writable<Default<string[], []>>;
}

interface FolksonomyTagsOutput {
  [NAME]: string;
  [UI]: VNode;
  tags: string[];
  addTag: Stream<{ tag: string }>;
  removeTag: Stream<{ tag: string }>;
}

/**
 * Autocomplete item structure for ct-autocomplete.
 */
interface AutocompleteItem {
  value: string;
  label: string;
  group: string;
  searchAliases?: string[];
  data?: { count?: number };
}

// Helper to send stream events safely
// The stream is a derived Cell - just call .send() if it has the method
function sendStreamEvent(postEventStream: any, event: TagEvent) {
  if (!postEventStream?.send) return;
  postEventStream.send(event);
}

// Handler for selecting a tag from autocomplete
const handleSelectTag = handler<
  { detail: { value: string; group?: string; isCustom?: boolean } },
  {
    scope: any;
    tags: Writable<string[]>;
    postEventStream: any;
  }
>((event, state) => {
  const value = event.detail?.value;
  if (!value) return;

  const scopeVal = state.scope?.get ? state.scope.get() : state.scope;
  const currentTags = state.tags.get() || [];
  const tagLower = value.toLowerCase().trim();

  // Check if already exists
  if (currentTags.some((t: string) => t.toLowerCase() === tagLower)) {
    // Post "use" event - user selected an existing tag
    sendStreamEvent(state.postEventStream, {
      scope: scopeVal,
      tag: value.trim(),
      action: "use",
      timestamp: Date.now(),
    });
    return;
  }

  // Add the new tag
  state.tags.set([...currentTags, value.trim()]);

  // Post "add" event to aggregator
  sendStreamEvent(state.postEventStream, {
    scope: scopeVal,
    tag: value.trim(),
    action: "add",
    timestamp: Date.now(),
  });
});

// Handler for removing a tag
const handleRemoveTag = handler<
  unknown,
  {
    scope: any;
    tags: Writable<string[]>;
    tag: string;
    postEventStream: any;
  }
>((_event, state) => {
  const scopeVal = state.scope?.get ? state.scope.get() : state.scope;
  const currentTags = state.tags.get() || [];
  state.tags.set(currentTags.filter((t: string) => t !== state.tag));

  // Post "remove" event to aggregator
  sendStreamEvent(state.postEventStream, {
    scope: scopeVal,
    tag: state.tag,
    action: "remove",
    timestamp: Date.now(),
  });
});

// Handler exposed for programmatic tag addition
const addTagHandler = handler<
  { tag: string },
  {
    scope: any;
    tags: Writable<string[]>;
    postEventStream: any;
  }
>((event, state) => {
  const tag = event.tag?.trim();
  if (!tag) return;

  const scopeVal = state.scope?.get ? state.scope.get() : state.scope;
  const currentTags = state.tags.get() || [];
  if (currentTags.some((t: string) => t.toLowerCase() === tag.toLowerCase())) {
    return;
  }

  state.tags.set([...currentTags, tag]);

  sendStreamEvent(state.postEventStream, {
    scope: scopeVal,
    tag: tag,
    action: "add",
    timestamp: Date.now(),
  });
});

// Handler exposed for programmatic tag removal
const removeTagHandler = handler<
  { tag: string },
  {
    scope: any;
    tags: Writable<string[]>;
    postEventStream: any;
  }
>((event, state) => {
  const tag = event.tag?.trim();
  if (!tag) return;

  const scopeVal = state.scope?.get ? state.scope.get() : state.scope;
  const currentTags = state.tags.get() || [];
  state.tags.set(currentTags.filter((t: string) => t !== tag));

  sendStreamEvent(state.postEventStream, {
    scope: scopeVal,
    tag: tag,
    action: "remove",
    timestamp: Date.now(),
  });
});

// Lift function to check if we have tags
const hasTags = lift((tags: string[]) => tags && tags.length > 0);

// Lift function to build autocomplete items
const buildAutocompleteItems = lift(
  ({
    localTags,
    communitySuggestions,
    currentTags,
  }: {
    localTags: string[];
    communitySuggestions: CommunityTagSuggestion[];
    currentTags: string[];
  }): AutocompleteItem[] => {
    const items: AutocompleteItem[] = [];
    const currentTagsLower = new Set(
      (currentTags || []).map((t) => t.toLowerCase()),
    );

    // Add local tags first (from user's space with same scope)
    for (const tag of localTags || []) {
      if (!currentTagsLower.has(tag.toLowerCase())) {
        items.push({
          value: tag,
          label: tag,
          group: "Your tags",
        });
      }
    }

    // Add community suggestions (not already in local or current)
    const localTagsLower = new Set(
      (localTags || []).map((t) => t.toLowerCase()),
    );
    for (const suggestion of communitySuggestions || []) {
      if (
        !currentTagsLower.has(suggestion.tag.toLowerCase()) &&
        !localTagsLower.has(suggestion.tag.toLowerCase())
      ) {
        items.push({
          value: suggestion.tag,
          label: `${suggestion.tag} (${suggestion.count})`,
          group: "Community",
          data: { count: suggestion.count },
        });
      }
    }

    return items;
  },
);

export const FolksonomyTags = recipe<FolksonomyTagsInput, FolksonomyTagsOutput>(
  "FolksonomyTags",
  ({ scope, tags }) => {
    // Wish for the aggregator charm (may not exist)
    // Using object form { query: "#..." } to get WishState with .result property
    const aggregatorWish = wish<AggregatorCharm>({
      query: "#folksonomy-aggregator",
    });

    // Extract the aggregator result
    const aggregator = aggregatorWish.result;

    // Derive just the postEvent stream Cell
    // Following verified pattern from test-cross-charm-client.tsx:
    // Derive the stream so it arrives as a Cell in handlers
    const postEventStream = derive(aggregator, (agg: any) => agg?.postEvent);

    // Get community suggestions for this scope
    const communitySuggestions = derive(
      [aggregator, scope],
      ([agg, scopeValue]: [any, string]) => {
        if (!agg || !scopeValue) return [];
        const suggs = agg.suggestions || {};
        return suggs[scopeValue] || [];
      },
    );

    // For now, local tags are just the current tags (same scope within same charm)
    const localTags = derive(tags, (t: string[]) => t || []);

    // Build autocomplete items combining local and community
    const autocompleteItems = buildAutocompleteItems({
      localTags,
      communitySuggestions,
      currentTags: tags,
    });

    // Check if aggregator is connected
    const hasAggregator = derive(aggregator, (agg: any) => agg != null);

    // Computed name for display
    const displayName = derive(tags, (tagList: string[]) => {
      if (!tagList || tagList.length === 0) return "🏷️ Tags";
      return `🏷️ Tags (${tagList.length})`;
    });

    return {
      [NAME]: displayName,
      [UI]: (
        <ct-vstack gap="3" style={{ padding: "8px 0" }}>
          {/* Autocomplete input */}
          {/* Hidden render to force aggregator to execute */}
          <div style={{ display: "none" }}>
            <ct-render $cell={aggregator} />
          </div>

          {/* Autocomplete input */}
          <ct-autocomplete
            items={autocompleteItems}
            placeholder="Add a tag..."
            allowCustom
            onct-select={handleSelectTag({
              scope,
              tags,
              postEventStream,
            })}
          />

          {/* Current tags */}
          {hasTags(tags)
            ? (
              <ct-hstack gap="2" wrap>
                {tags.map((tag: string, index: number) => (
                  <span
                    key={index}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                      padding: "4px 8px 4px 10px",
                      background: "#f3f4f6",
                      borderRadius: "16px",
                      fontSize: "14px",
                    }}
                  >
                    <span>{tag}</span>
                    <button
                      type="button"
                      onClick={handleRemoveTag({
                        scope,
                        tags,
                        tag,
                        postEventStream,
                      })}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: "0 2px",
                        fontSize: "14px",
                        color: "#9ca3af",
                        lineHeight: 1,
                      }}
                      title="Remove tag"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </ct-hstack>
            )
            : (
              <span style={{ color: "#9ca3af", fontSize: "13px" }}>
                No tags yet. Type to add one.
              </span>
            )}

          {/* Aggregator status indicator */}
          <ct-hstack
            gap="1"
            align="center"
            style={{ fontSize: "11px", color: "#9ca3af" }}
          >
            <span
              style={{
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: hasAggregator ? "#22c55e" : "#d1d5db",
              }}
            />
            <span>
              {hasAggregator
                ? "Connected to community aggregator"
                : "Local mode (favorite folksonomy-aggregator for community)"}
            </span>
          </ct-hstack>
        </ct-vstack>
      ),
      tags,
      addTag: addTagHandler({
        scope,
        tags,
        postEventStream,
      }),
      removeTag: removeTagHandler({
        scope,
        tags,
        postEventStream,
      }),
    };
  },
);

export default FolksonomyTags;
