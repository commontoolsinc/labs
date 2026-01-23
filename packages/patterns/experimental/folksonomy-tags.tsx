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
  computed,
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

// Handler for selecting a tag from autocomplete
const handleSelectTag = handler<
  { detail: { value: string; group?: string; isCustom?: boolean } },
  {
    scope: string;
    tags: Writable<string[]>;
    aggregatorStream: Stream<TagEvent> | undefined;
  }
>((event, state) => {
  const value = event.detail?.value;
  if (!value) return;

  const currentTags = state.tags.get() || [];
  const tagLower = value.toLowerCase().trim();

  // Check if already exists
  if (currentTags.some((t) => t.toLowerCase() === tagLower)) {
    // Post "use" event - user selected an existing tag
    if (state.aggregatorStream) {
      const streamCell = state.aggregatorStream as any;
      const inner = streamCell.get ? streamCell.get() : streamCell;
      if (inner && inner.$stream) {
        streamCell.send({
          scope: state.scope,
          tag: value.trim(),
          action: "use",
          timestamp: Date.now(),
        });
      }
    }
    return;
  }

  // Add the new tag
  state.tags.set([...currentTags, value.trim()]);

  // Post "add" event to aggregator
  if (state.aggregatorStream) {
    const streamCell = state.aggregatorStream as any;
    const inner = streamCell.get ? streamCell.get() : streamCell;
    if (inner && inner.$stream) {
      streamCell.send({
        scope: state.scope,
        tag: value.trim(),
        action: "add",
        timestamp: Date.now(),
      });
    }
  }
});

// Handler for removing a tag
const handleRemoveTag = handler<
  unknown,
  {
    scope: string;
    tags: Writable<string[]>;
    tag: string;
    aggregatorStream: Stream<TagEvent> | undefined;
  }
>((_event, state) => {
  const currentTags = state.tags.get() || [];
  state.tags.set(currentTags.filter((t) => t !== state.tag));

  // Post "remove" event to aggregator
  if (state.aggregatorStream) {
    const streamCell = state.aggregatorStream as any;
    const inner = streamCell.get ? streamCell.get() : streamCell;
    if (inner && inner.$stream) {
      streamCell.send({
        scope: state.scope,
        tag: state.tag,
        action: "remove",
        timestamp: Date.now(),
      });
    }
  }
});

// Handler exposed for programmatic tag addition
const addTagHandler = handler<
  { tag: string },
  {
    scope: string;
    tags: Writable<string[]>;
    aggregatorStream: Stream<TagEvent> | undefined;
  }
>((event, state) => {
  const tag = event.tag?.trim();
  if (!tag) return;

  const currentTags = state.tags.get() || [];
  if (currentTags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
    return;
  }

  state.tags.set([...currentTags, tag]);

  if (state.aggregatorStream) {
    const streamCell = state.aggregatorStream as any;
    const inner = streamCell.get ? streamCell.get() : streamCell;
    if (inner && inner.$stream) {
      streamCell.send({
        scope: state.scope,
        tag: tag,
        action: "add",
        timestamp: Date.now(),
      });
    }
  }
});

// Handler exposed for programmatic tag removal
const removeTagHandler = handler<
  { tag: string },
  {
    scope: string;
    tags: Writable<string[]>;
    aggregatorStream: Stream<TagEvent> | undefined;
  }
>((event, state) => {
  const tag = event.tag?.trim();
  if (!tag) return;

  const currentTags = state.tags.get() || [];
  state.tags.set(currentTags.filter((t) => t !== tag));

  if (state.aggregatorStream) {
    const streamCell = state.aggregatorStream as any;
    const inner = streamCell.get ? streamCell.get() : streamCell;
    if (inner && inner.$stream) {
      streamCell.send({
        scope: state.scope,
        tag: tag,
        action: "remove",
        timestamp: Date.now(),
      });
    }
  }
});

// Lift function to check if we have tags
const hasTags = lift<string[], boolean>((tags) => tags && tags.length > 0);

// Lift function to build autocomplete items
const buildAutocompleteItems = lift<
  {
    localTags: string[];
    communitySuggestions: CommunityTagSuggestion[];
    currentTags: string[];
  },
  AutocompleteItem[]
>(({ localTags, communitySuggestions, currentTags }) => {
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
  const localTagsLower = new Set((localTags || []).map((t) => t.toLowerCase()));
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
});

export const FolksonomyTags = recipe<FolksonomyTagsInput, FolksonomyTagsOutput>(
  "FolksonomyTags",
  ({ scope, tags }) => {
    // Wish for the aggregator charm (may not exist)
    // Using object form { query: "#..." } to get WishState with .result property
    const aggregatorWish = wish<AggregatorCharm>({
      query: "#folksonomy-aggregator",
    });

    // Extract the aggregator result and stream
    const aggregator = aggregatorWish.result;
    const aggregatorStream = derive(
      aggregator,
      (agg: AggregatorCharm | undefined | null) => agg?.postEvent,
    );

    // Get community suggestions for this scope
    const communitySuggestions = computed(() => {
      const agg = aggregator as AggregatorCharm | undefined;
      const scopeValue = (scope as any)?.get?.() ?? scope;
      if (!agg || !scopeValue) return [];
      const suggs = agg.suggestions || {};
      return suggs[scopeValue] || [];
    });

    // For now, local tags are just the current tags (same scope within same charm)
    // In a more advanced version, this could query all charms with the same scope
    const localTags = derive(tags, (t: string[] | undefined) => t || []);

    // Build autocomplete items combining local and community
    const autocompleteItems = computed(() => {
      return buildAutocompleteItems({
        localTags: localTags as unknown as string[],
        communitySuggestions:
          communitySuggestions as unknown as CommunityTagSuggestion[],
        currentTags: (tags || []) as unknown as string[],
      });
    });

    // Check if aggregator is connected
    const hasAggregator = computed(() => {
      const agg = aggregator as AggregatorCharm | undefined;
      return agg !== undefined && agg !== null;
    });

    // Computed name for display
    const displayName = derive(tags, (tagList: string[] | undefined) => {
      if (!tagList || tagList.length === 0) return "🏷️ Tags";
      return `🏷️ Tags (${tagList.length})`;
    });

    // Get scope value for handlers
    const scopeValue = computed(() => {
      return ((scope as any)?.get?.() ?? scope) as string;
    });

    return {
      [NAME]: displayName,
      [UI]: (
        <ct-vstack gap="3" style={{ padding: "8px 0" }}>
          {/* Autocomplete input */}
          <ct-autocomplete
            items={autocompleteItems}
            placeholder="Add a tag..."
            allowCustom
            onct-select={handleSelectTag({
              scope: scopeValue as unknown as string,
              tags,
              aggregatorStream: aggregatorStream as unknown as
                | Stream<TagEvent>
                | undefined,
            })}
          />

          {/* Current tags */}
          {hasTags(tags as unknown as string[])
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
                        scope: scopeValue as unknown as string,
                        tags,
                        tag,
                        aggregatorStream: aggregatorStream as unknown as
                          | Stream<TagEvent>
                          | undefined,
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
        scope: scopeValue as unknown as string,
        tags,
        aggregatorStream: aggregatorStream as unknown as
          | Stream<TagEvent>
          | undefined,
      }),
      removeTag: removeTagHandler({
        scope: scopeValue as unknown as string,
        tags,
        aggregatorStream: aggregatorStream as unknown as
          | Stream<TagEvent>
          | undefined,
      }),
    };
  },
);

export default FolksonomyTags;
