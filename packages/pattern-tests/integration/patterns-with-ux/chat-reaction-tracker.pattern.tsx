/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  compute,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

export interface ReactionMessageInput {
  id?: string;
  content?: string;
  reactions?: Record<string, number>;
}

interface ReactionEvent {
  messageId?: unknown;
  reaction?: unknown;
  delta?: unknown;
}

export interface NormalizedMessage {
  id: string;
  content: string;
  reactions: Record<string, number>;
}

export interface ReactionCountEntry {
  reaction: string;
  count: number;
}

export interface MessageReactionView {
  id: string;
  content: string;
  reactions: ReactionCountEntry[];
}

export interface MessageTotalEntry {
  id: string;
  content: string;
  total: number;
}

export interface ReactionTotalEntry {
  reaction: string;
  count: number;
}

export interface ReactionMatrixRow {
  messageId: string;
  reaction: string;
  count: number;
}

export interface ChatReactionTrackerArgs {
  messages: Default<ReactionMessageInput[], typeof defaultMessages>;
  reactionCatalog: Default<string[], typeof defaultReactions>;
}

const defaultMessages: ReactionMessageInput[] = [
  {
    id: "msg1",
    content: "Great work on the presentation! 🎯",
    reactions: { "👍": 5, "🎉": 2 },
  },
  {
    id: "msg2",
    content: "When is the next team meeting?",
    reactions: { "👍": 1, "❤️": 3 },
  },
  {
    id: "msg3",
    content: "Thanks for the code review! 💻",
    reactions: { "👍": 8, "🎉": 4, "😂": 1 },
  },
  {
    id: "msg4",
    content: "Happy Friday everyone! 🌟",
    reactions: { "❤️": 12, "🎉": 7 },
  },
];

const defaultReactions: string[] = ["👍", "❤️", "😂", "🎉"];

const normalizeMessageId = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeReactionKey = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const toNonNegativeInteger = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const integer = Math.trunc(value);
  return integer >= 0 ? integer : undefined;
};

const sanitizeReactionCatalog = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    const reaction = normalizeReactionKey(entry);
    if (!reaction || seen.has(reaction)) continue;
    seen.add(reaction);
  }
  return [...seen].sort((a, b) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
};

const sanitizeReactionCounts = (
  value: unknown,
  catalog: readonly string[],
): Record<string, number> => {
  const map = new Map<string, number>();
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [rawKey, rawValue] of entries) {
      const reaction = normalizeReactionKey(rawKey);
      const count = toNonNegativeInteger(rawValue);
      if (!reaction || count === undefined) continue;
      map.set(reaction, count);
    }
  }

  for (const reaction of catalog) {
    if (!map.has(reaction)) {
      map.set(reaction, 0);
    }
  }

  const normalized = [...map.entries()].sort((a, b) => {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    return 0;
  });
  const result: Record<string, number> = {};
  for (const [reaction, count] of normalized) {
    result[reaction] = count;
  }
  return result;
};

const sanitizeMessageContent = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const sanitizeMessages = (
  value: unknown,
  catalog: readonly string[],
): NormalizedMessage[] => {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const sanitized: NormalizedMessage[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const base = entry as ReactionMessageInput;
    const id = normalizeMessageId(base.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const content = sanitizeMessageContent(base.content, id);
    const reactions = sanitizeReactionCounts(base.reactions, catalog);
    sanitized.push({ id, content, reactions });
  }

  sanitized.sort((a, b) => a.id.localeCompare(b.id));
  return sanitized;
};

const cloneNormalizedMessage = (
  message: NormalizedMessage,
): ReactionMessageInput => ({
  id: message.id,
  content: message.content,
  reactions: { ...message.reactions },
});

const sumReactions = (counts: Record<string, number>): number => {
  let total = 0;
  for (const value of Object.values(counts)) {
    total += value;
  }
  return total;
};

const sanitizeDelta = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }
  const integer = Math.trunc(value);
  return integer === 0 ? 0 : integer;
};

const recordMessageReaction = handler(
  (
    event: ReactionEvent | undefined,
    context: {
      messages: Cell<ReactionMessageInput[]>;
      reactionCatalog: Cell<string[]>;
    },
  ) => {
    const messageId = normalizeMessageId(event?.messageId);
    const reactionKey = normalizeReactionKey(event?.reaction);
    const delta = sanitizeDelta(event?.delta);

    if (!messageId || !reactionKey || delta === 0) {
      return;
    }

    const baseCatalog = sanitizeReactionCatalog(
      context.reactionCatalog.get(),
    );
    const nextCatalog = sanitizeReactionCatalog([
      ...baseCatalog,
      reactionKey,
    ]);
    context.reactionCatalog.set([...nextCatalog]);

    const currentMessages = sanitizeMessages(
      context.messages.get(),
      nextCatalog,
    );
    const index = currentMessages.findIndex((item) => item.id === messageId);
    if (index === -1) return;

    const target = currentMessages[index];
    const currentCount = target.reactions[reactionKey] ?? 0;
    const updatedCount = currentCount + delta;
    const nextCount = updatedCount < 0 ? 0 : updatedCount;

    const updatedMessages = currentMessages.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      const reactions = sanitizeReactionCounts(
        { ...item.reactions, [reactionKey]: nextCount },
        nextCatalog,
      );
      return { ...item, reactions };
    });

    context.messages.set(
      updatedMessages.map((message) => cloneNormalizedMessage(message)),
    );
  },
);

export const chatReactionTracker = recipe<ChatReactionTrackerArgs>(
  "Chat Reaction Tracker",
  ({ messages, reactionCatalog }) => {
    const catalogView = lift(sanitizeReactionCatalog)(reactionCatalog);

    const normalizedMessages = lift(
      (
        { list, catalog }: {
          list: ReactionMessageInput[] | undefined;
          catalog: string[];
        },
      ) => sanitizeMessages(list, catalog),
    )({
      list: messages,
      catalog: catalogView,
    });

    const messagesView = lift((entries: NormalizedMessage[]) =>
      entries.map((message) => {
        const reactions = Object.entries(message.reactions)
          .map(([reaction, count]) => ({ reaction, count }))
          .sort((a, b) => {
            if (a.reaction < b.reaction) return -1;
            if (a.reaction > b.reaction) return 1;
            return 0;
          });
        return { id: message.id, content: message.content, reactions };
      })
    )(normalizedMessages);

    const messageTotals = lift((entries: NormalizedMessage[]) =>
      entries.map((message) => ({
        id: message.id,
        content: message.content,
        total: sumReactions(message.reactions),
      }))
    )(normalizedMessages);

    const reactionTotals = lift((entries: NormalizedMessage[]) => {
      const totals = new Map<string, number>();
      for (const message of entries) {
        for (const [reaction, count] of Object.entries(message.reactions)) {
          totals.set(reaction, (totals.get(reaction) ?? 0) + count);
        }
      }
      return [...totals.entries()]
        .sort((a, b) => {
          if (a[0] < b[0]) return -1;
          if (a[0] > b[0]) return 1;
          return 0;
        })
        .map(([reaction, count]) => ({ reaction, count }));
    })(normalizedMessages);

    const reactionMatrix = lift((entries: NormalizedMessage[]) => {
      const rows: ReactionMatrixRow[] = [];
      for (const message of entries) {
        const reactions = Object.entries(message.reactions).sort((a, b) => {
          if (a[0] < b[0]) return -1;
          if (a[0] > b[0]) return 1;
          return 0;
        });
        for (const [reaction, count] of reactions) {
          rows.push({ messageId: message.id, reaction, count });
        }
      }
      return rows;
    })(normalizedMessages);

    const messageCount = lift((entries: NormalizedMessage[]) => entries.length)(
      normalizedMessages,
    );

    const totalReactions = lift((entries: ReactionTotalEntry[]) =>
      entries.reduce((sum, entry) => sum + entry.count, 0)
    )(reactionTotals);

    const summary = str`${totalReactions} reactions across ${messageCount} \
messages`;

    // UI state
    const messageIdField = cell("");
    const reactionField = cell("");
    const newMessageIdField = cell("");
    const newMessageContentField = cell("");

    // UI-specific handlers
    const addMessageHandler = handler((
      _event: unknown,
      context: {
        newMessageIdField: Cell<string>;
        newMessageContentField: Cell<string>;
        messages: Cell<ReactionMessageInput[]>;
        reactionCatalog: Cell<string[]>;
      },
    ) => {
      const idValue = context.newMessageIdField.get();
      const contentValue = context.newMessageContentField.get();

      const id = normalizeMessageId(idValue);
      const content =
        typeof contentValue === "string" && contentValue.trim() !== ""
          ? contentValue.trim()
          : undefined;

      if (!id || !content) {
        return;
      }

      const catalog = sanitizeReactionCatalog(context.reactionCatalog.get());
      const currentMessages = sanitizeMessages(context.messages.get(), catalog);

      // Check if message ID already exists
      if (currentMessages.some((msg) => msg.id === id)) {
        return;
      }

      const newMessage: NormalizedMessage = {
        id,
        content,
        reactions: sanitizeReactionCounts({}, catalog),
      };

      const updatedMessages = [...currentMessages, newMessage];
      updatedMessages.sort((a, b) => a.id.localeCompare(b.id));

      context.messages.set(
        updatedMessages.map((message) => cloneNormalizedMessage(message)),
      );

      context.newMessageIdField.set("");
      context.newMessageContentField.set("");
    });
    const addReactionHandler = handler((
      _event: unknown,
      context: {
        messageIdField: Cell<string>;
        reactionField: Cell<string>;
        messages: Cell<ReactionMessageInput[]>;
        reactionCatalog: Cell<string[]>;
      },
    ) => {
      const messageIdValue = context.messageIdField.get();
      const reactionValue = context.reactionField.get();

      const messageId = normalizeMessageId(messageIdValue);
      const reactionKey = normalizeReactionKey(reactionValue);

      if (!messageId || !reactionKey) {
        return;
      }

      const baseCatalog = sanitizeReactionCatalog(
        context.reactionCatalog.get(),
      );
      const nextCatalog = sanitizeReactionCatalog([
        ...baseCatalog,
        reactionKey,
      ]);
      context.reactionCatalog.set([...nextCatalog]);

      const currentMessages = sanitizeMessages(
        context.messages.get(),
        nextCatalog,
      );
      const index = currentMessages.findIndex((item) => item.id === messageId);
      if (index === -1) return;

      const target = currentMessages[index];
      const currentCount = target.reactions[reactionKey] ?? 0;
      const nextCount = currentCount + 1;

      const updatedMessages = currentMessages.map((item, itemIndex) => {
        if (itemIndex !== index) return item;
        const reactions = sanitizeReactionCounts(
          { ...item.reactions, [reactionKey]: nextCount },
          nextCatalog,
        );
        return { ...item, reactions };
      });

      context.messages.set(
        updatedMessages.map((message) => cloneNormalizedMessage(message)),
      );

      context.messageIdField.set("");
      context.reactionField.set("");
    });

    const removeReactionHandler = handler((
      _event: unknown,
      context: {
        messageIdField: Cell<string>;
        reactionField: Cell<string>;
        messages: Cell<ReactionMessageInput[]>;
        reactionCatalog: Cell<string[]>;
      },
    ) => {
      const messageIdValue = context.messageIdField.get();
      const reactionValue = context.reactionField.get();

      const messageId = normalizeMessageId(messageIdValue);
      const reactionKey = normalizeReactionKey(reactionValue);

      if (!messageId || !reactionKey) {
        return;
      }

      const baseCatalog = sanitizeReactionCatalog(
        context.reactionCatalog.get(),
      );
      const currentMessages = sanitizeMessages(
        context.messages.get(),
        baseCatalog,
      );
      const index = currentMessages.findIndex((item) => item.id === messageId);
      if (index === -1) return;

      const target = currentMessages[index];
      const currentCount = target.reactions[reactionKey] ?? 0;
      const nextCount = currentCount > 0 ? currentCount - 1 : 0;

      const updatedMessages = currentMessages.map((item, itemIndex) => {
        if (itemIndex !== index) return item;
        const reactions = sanitizeReactionCounts(
          { ...item.reactions, [reactionKey]: nextCount },
          baseCatalog,
        );
        return { ...item, reactions };
      });

      context.messages.set(
        updatedMessages.map((message) => cloneNormalizedMessage(message)),
      );

      context.messageIdField.set("");
      context.reactionField.set("");
    });

    const name = str`Chat Reactions`;

    const ui = (
      <div style="max-width: 800px; margin: 0 auto; padding: 1.5rem; font-family: system-ui, -apple-system, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh;">
        <div style="background: white; border-radius: 1rem; padding: 1.5rem; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
          <div style="text-align: center; margin-bottom: 2rem;">
            <h1 style="font-size: 2rem; font-weight: 700; background: linear-gradient(135deg, #667eea, #764ba2); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin: 0 0 0.5rem 0;">
              💬 Chat Reaction Tracker
            </h1>
            <p style="color: #64748b; font-size: 0.875rem; margin: 0;">
              {summary}
            </p>
          </div>

          {lift((
            totals: ReactionTotalEntry[],
          ) => {
            if (totals.length === 0) {
              return h(
                "div",
                {
                  style:
                    "text-align: center; padding: 2rem; color: #94a3b8; font-size: 0.875rem;",
                },
                "No reactions yet",
              );
            }

            const cards = [];
            for (const entry of totals) {
              const reactionEmoji = entry.reaction.startsWith(":")
                ? entry.reaction.slice(1, -1)
                : entry.reaction;
              cards.push(
                h(
                  "div",
                  {
                    style:
                      "background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%); border: 2px solid #0ea5e9; border-radius: 0.75rem; padding: 1rem; text-align: center;",
                  },
                  h(
                    "div",
                    { style: "font-size: 2rem; margin-bottom: 0.5rem;" },
                    reactionEmoji,
                  ),
                  h(
                    "div",
                    {
                      style:
                        "font-size: 1.5rem; font-weight: 700; color: #0369a1;",
                    },
                    String(entry.count),
                  ),
                  h(
                    "div",
                    { style: "font-size: 0.75rem; color: #64748b;" },
                    entry.reaction,
                  ),
                ),
              );
            }

            return h(
              "div",
              {
                style:
                  "display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 1rem; margin-bottom: 2rem;",
              },
              ...cards,
            );
          })(reactionTotals)}

          <div style="background: #f8fafc; border-radius: 0.75rem; padding: 1.5rem; margin-bottom: 1.5rem;">
            <h2 style="font-size: 1.25rem; font-weight: 600; color: #1e293b; margin: 0 0 1rem 0;">
              Add New Message
            </h2>
            <div style="display: grid; gap: 0.75rem; margin-bottom: 1rem;">
              <ct-input
                $value={newMessageIdField}
                placeholder="Message ID (e.g., msg1)"
                style="padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 0.5rem; font-size: 0.875rem;"
              />
              <ct-input
                $value={newMessageContentField}
                placeholder="Message content"
                style="padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 0.5rem; font-size: 0.875rem;"
              />
            </div>
            <ct-button
              onClick={addMessageHandler({
                newMessageIdField,
                newMessageContentField,
                messages,
                reactionCatalog,
              })}
              style="width: 100%; background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: white; padding: 0.75rem; border-radius: 0.5rem; font-weight: 600; cursor: pointer; border: none; font-size: 0.875rem;"
            >
              ➕ Add Message
            </ct-button>
          </div>

          <div style="background: #f8fafc; border-radius: 0.75rem; padding: 1.5rem; margin-bottom: 1.5rem;">
            <h2 style="font-size: 1.25rem; font-weight: 600; color: #1e293b; margin: 0 0 1rem 0;">
              Add/Remove Reactions
            </h2>
            <div style="display: grid; gap: 0.75rem; margin-bottom: 1rem;">
              <ct-input
                $value={messageIdField}
                placeholder="Message ID"
                style="padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 0.5rem; font-size: 0.875rem;"
              />
              <ct-input
                $value={reactionField}
                placeholder="Reaction (e.g., 👍 or :thumbsup:)"
                style="padding: 0.75rem; border: 2px solid #e2e8f0; border-radius: 0.5rem; font-size: 0.875rem;"
              />
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
              <ct-button
                onClick={addReactionHandler({
                  messageIdField,
                  reactionField,
                  messages,
                  reactionCatalog,
                })}
                style="background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 0.75rem; border-radius: 0.5rem; font-weight: 600; cursor: pointer; border: none; font-size: 0.875rem;"
              >
                ➕ Add Reaction
              </ct-button>
              <ct-button
                onClick={removeReactionHandler({
                  messageIdField,
                  reactionField,
                  messages,
                  reactionCatalog,
                })}
                style="background: linear-gradient(135deg, #ef4444, #dc2626); color: white; padding: 0.75rem; border-radius: 0.5rem; font-weight: 600; cursor: pointer; border: none; font-size: 0.875rem;"
              >
                ➖ Remove Reaction
              </ct-button>
            </div>
          </div>

          <div>
            <h2 style="font-size: 1.25rem; font-weight: 600; color: #1e293b; margin: 0 0 1rem 0;">
              Messages
            </h2>
            {lift((
              msgs: MessageReactionView[],
            ) => {
              if (msgs.length === 0) {
                return h(
                  "div",
                  {
                    style:
                      "text-align: center; padding: 2rem; color: #94a3b8; font-size: 0.875rem; background: #f8fafc; border-radius: 0.75rem;",
                  },
                  "No messages yet",
                );
              }

              const messageCards = [];
              for (const msg of msgs) {
                const reactionBadges = [];
                for (const r of msg.reactions) {
                  if (r.count > 0) {
                    const emoji = r.reaction.startsWith(":")
                      ? r.reaction.slice(1, -1)
                      : r.reaction;
                    reactionBadges.push(
                      h(
                        "span",
                        {
                          style:
                            "display: inline-flex; align-items: center; gap: 0.25rem; background: #e0f2fe; color: #0369a1; padding: 0.25rem 0.5rem; border-radius: 0.375rem; font-size: 0.75rem; font-weight: 600;",
                        },
                        h("span", {}, emoji),
                        h("span", {}, String(r.count)),
                      ),
                    );
                  }
                }

                messageCards.push(
                  h(
                    "div",
                    {
                      style:
                        "background: white; border: 2px solid #e2e8f0; border-radius: 0.75rem; padding: 1rem; margin-bottom: 0.75rem;",
                    },
                    h(
                      "div",
                      {
                        style:
                          "display: flex; justify-content: space-between; align-items: start; margin-bottom: 0.5rem;",
                      },
                      h(
                        "div",
                        {
                          style:
                            "font-weight: 600; color: #1e293b; font-size: 0.875rem;",
                        },
                        msg.content,
                      ),
                      h(
                        "div",
                        {
                          style:
                            "background: #f1f5f9; padding: 0.125rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem; color: #64748b; font-family: monospace;",
                        },
                        msg.id,
                      ),
                    ),
                    reactionBadges.length > 0
                      ? h(
                        "div",
                        {
                          style: "display: flex; flex-wrap: wrap; gap: 0.5rem;",
                        },
                        ...reactionBadges,
                      )
                      : h(
                        "div",
                        {
                          style:
                            "color: #94a3b8; font-size: 0.75rem; font-style: italic;",
                        },
                        "No reactions yet",
                      ),
                  ),
                );
              }

              return h("div", {}, ...messageCards);
            })(messagesView)}
          </div>
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      messages: messagesView,
      reactionCatalog: catalogView,
      messageTotals,
      reactionTotals,
      reactionMatrix,
      messageCount,
      totalReactions,
      summary,
      recordReaction: recordMessageReaction({ messages, reactionCatalog }),
    };
  },
);
