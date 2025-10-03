/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

type Frequency = "daily" | "weekly" | "monthly";

interface SavedSearchInput {
  id?: string;
  name?: string;
  query?: string;
  frequency?: string;
  channels?: unknown;
}

interface SavedSearchSubscription {
  id: string;
  name: string;
  query: string;
  frequency: Frequency;
  channels: string[];
}

interface SavedSearchArgs {
  savedSubscriptions: Default<
    SavedSearchInput[],
    typeof defaultSavedSubscriptions
  >;
}

interface SavedSubscriptionEvent {
  id?: string;
  name?: string;
  query?: string;
  frequency?: string;
  channels?: unknown;
}

interface TriggerSubscriptionEvent {
  id?: string;
}

const defaultFrequency: Frequency = "weekly";
const defaultChannels = ["email"] as const;
const defaultSubscriptionName = "Saved Search";
const defaultSubscriptionQuery = "all results";

const allowedFrequencies: ReadonlySet<Frequency> = new Set([
  "daily",
  "weekly",
  "monthly",
]);

const channelOrder = new Map<string, number>([
  ["email", 0],
  ["push", 1],
  ["sms", 2],
  ["digest", 3],
]);

const defaultSavedSubscriptions: SavedSearchInput[] = [
  {
    id: "remote-design-weekly",
    name: "Remote Design Roles",
    query: "designer remote",
    frequency: "weekly",
    channels: ["email", "push"],
  },
  {
    id: "analytics-alerts-daily",
    name: "Analytics Alerts",
    query: "analytics engineer",
    frequency: "daily",
    channels: ["email"],
  },
];

const titleCase = (value: string): string => {
  return value.split(/\s+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const lower = segment.toLowerCase();
      const head = lower.charAt(0).toUpperCase();
      return `${head}${lower.slice(1)}`;
    })
    .join(" ");
};

const sanitizeName = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return titleCase(trimmed);
    }
  }
  return titleCase(fallback);
};

const sanitizeQuery = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
};

const sanitizeFrequency = (
  value: unknown,
  fallback: Frequency,
): Frequency => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (allowedFrequencies.has(normalized as Frequency)) {
      return normalized as Frequency;
    }
  }
  return fallback;
};

const sanitizeChannels = (
  value: unknown,
  fallback: readonly string[],
): string[] => {
  const source = Array.isArray(value) ? value : fallback;
  const seen = new Set<string>();
  const sanitized: string[] = [];
  for (const raw of source) {
    if (typeof raw !== "string") continue;
    const normalized = raw.trim().toLowerCase();
    if (normalized.length === 0) continue;
    if (!channelOrder.has(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    sanitized.push(normalized);
  }
  if (sanitized.length === 0) {
    return fallback.map((channel) => channel.toLowerCase());
  }
  sanitized.sort((left, right) => {
    const leftRank = channelOrder.get(left) ?? 99;
    const rightRank = channelOrder.get(right) ?? 99;
    return leftRank - rightRank;
  });
  return sanitized;
};

const slugify = (value: string): string => {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "").replace(/-+$/, "");
};

const ensureUniqueId = (candidate: string, used: Set<string>): string => {
  const base = candidate.length > 0 ? candidate : "saved-search";
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  const unique = `${base}-${suffix}`;
  used.add(unique);
  return unique;
};

const createSubscription = (
  raw: SavedSearchInput | SavedSubscriptionEvent | undefined,
  fallback: SavedSearchInput,
  used: Set<string>,
): SavedSearchSubscription => {
  const fallbackName = sanitizeName(
    fallback?.name,
    defaultSubscriptionName,
  );
  const fallbackQuery = sanitizeQuery(
    fallback?.query,
    defaultSubscriptionQuery,
  );
  const fallbackFrequency = sanitizeFrequency(
    fallback?.frequency,
    defaultFrequency,
  );
  const fallbackChannels = sanitizeChannels(
    fallback?.channels,
    defaultChannels,
  );

  const name = sanitizeName(raw?.name, fallbackName);
  const query = sanitizeQuery(raw?.query, fallbackQuery);
  const frequency = sanitizeFrequency(raw?.frequency, fallbackFrequency);
  const channels = sanitizeChannels(raw?.channels, fallbackChannels);

  const idSource = typeof raw?.id === "string"
    ? raw.id
    : `${name}-${frequency}`;
  const id = ensureUniqueId(slugify(idSource), used);

  return { id, name, query, frequency, channels };
};

const sanitizeSubscriptions = (
  value: unknown,
): SavedSearchSubscription[] => {
  const entries = Array.isArray(value) && value.length > 0
    ? (value as SavedSearchInput[])
    : defaultSavedSubscriptions;
  const used = new Set<string>();
  const sanitized: SavedSearchSubscription[] = [];
  for (let index = 0; index < entries.length; index++) {
    const fallback = defaultSavedSubscriptions[
      index % defaultSavedSubscriptions.length
    ];
    const subscription = createSubscription(entries[index], fallback, used);
    sanitized.push(subscription);
  }
  if (sanitized.length === 0) {
    sanitized.push(
      createSubscription(undefined, defaultSavedSubscriptions[0], used),
    );
  }
  return sanitized;
};

const toStringList = (value: unknown): string[] => {
  return Array.isArray(value) ? (value as string[]) : [];
};

const formatChannels = (channels: readonly string[]): string => {
  return channels.map((channel) => titleCase(channel)).join(", ");
};

const describeSaveAction = (
  subscription: SavedSearchSubscription,
): string => {
  const channelLabel = formatChannels(subscription.channels);
  return `Saved ${subscription.name} (${subscription.frequency}) via ` +
    `${channelLabel} for "${subscription.query}"`;
};

const describeTriggerAction = (
  subscription: SavedSearchSubscription,
): string => {
  const channelLabel = formatChannels(subscription.channels);
  return `Triggered ${subscription.name} (${subscription.frequency}) ` +
    `via ${channelLabel} for "${subscription.query}"`;
};

export const savedSearchSubscriptionUx = recipe<SavedSearchArgs>(
  "Saved Search Subscription (UX)",
  ({ savedSubscriptions }) => {
    const savedLog = cell<string[]>([]);
    const triggerLog = cell<string[]>([]);

    const sanitizedSubscriptions = lift(
      sanitizeSubscriptions,
    )(savedSubscriptions);

    const totalSubscriptions = lift((list: SavedSearchSubscription[]) =>
      list.length
    )(sanitizedSubscriptions);

    const nameField = cell<string>("");
    const queryField = cell<string>("");
    const frequencyField = cell<string>("weekly");
    const channelsField = cell<string>("email");
    const triggerIdField = cell<string>("");

    const addSubscriptionUi = handler<
      unknown,
      {
        savedSubscriptions: Cell<SavedSearchInput[]>;
        savedLog: Cell<string[]>;
        nameField: Cell<string>;
        queryField: Cell<string>;
        frequencyField: Cell<string>;
        channelsField: Cell<string>;
      }
    >(
      (
        _event,
        {
          savedSubscriptions,
          savedLog,
          nameField,
          queryField,
          frequencyField,
          channelsField,
        },
      ) => {
        const name = nameField.get();
        const query = queryField.get();
        const freq = frequencyField.get();
        const channelsStr = channelsField.get();

        if (
          typeof name !== "string" || name.trim() === "" ||
          typeof query !== "string" || query.trim() === ""
        ) {
          return;
        }

        const rawValue = savedSubscriptions.get();
        const current = sanitizeSubscriptions(rawValue);
        const used = new Set(current.map((entry) => entry.id));
        const fallback = defaultSavedSubscriptions[
          current.length % defaultSavedSubscriptions.length
        ];

        const channelsArray = typeof channelsStr === "string"
          ? channelsStr.split(",").map((c) => c.trim()).filter((c) =>
            c.length > 0
          )
          : ["email"];

        const nextSubscription = createSubscription(
          { name, query, frequency: freq, channels: channelsArray },
          fallback,
          used,
        );
        const updated = [...current, nextSubscription];
        savedSubscriptions.set(updated.map((entry) => ({
          id: entry.id,
          name: entry.name,
          query: entry.query,
          frequency: entry.frequency,
          channels: entry.channels,
        })));

        const savedEntries = toStringList(savedLog.get());
        savedLog.set([
          ...savedEntries,
          describeSaveAction(nextSubscription),
        ]);

        nameField.set("");
        queryField.set("");
        frequencyField.set("weekly");
        channelsField.set("email");
      },
    )({
      savedSubscriptions,
      savedLog,
      nameField,
      queryField,
      frequencyField,
      channelsField,
    });

    const triggerAllUi = handler<
      unknown,
      {
        savedSubscriptions: Cell<SavedSearchInput[]>;
        triggerLog: Cell<string[]>;
      }
    >((_event, { savedSubscriptions, triggerLog }) => {
      const subscriptions = sanitizeSubscriptions(
        savedSubscriptions.get(),
      );
      if (subscriptions.length === 0) return;
      const existing = toStringList(triggerLog.get());
      const updates = subscriptions.map(describeTriggerAction);
      triggerLog.set([...existing, ...updates]);
    })({ savedSubscriptions, triggerLog });

    const triggerOneUi = handler<
      unknown,
      {
        savedSubscriptions: Cell<SavedSearchInput[]>;
        triggerLog: Cell<string[]>;
        triggerIdField: Cell<string>;
      }
    >(
      (_event, { savedSubscriptions, triggerLog, triggerIdField }) => {
        const idInput = triggerIdField.get();
        if (typeof idInput !== "string" || idInput.trim() === "") return;

        const normalized = slugify(idInput);
        if (normalized.length === 0) return;

        const subscriptions = sanitizeSubscriptions(
          savedSubscriptions.get(),
        );
        const target = subscriptions.find((entry) =>
          entry.id === normalized || slugify(entry.name) === normalized
        );
        if (!target) return;

        const existing = toStringList(triggerLog.get());
        triggerLog.set([
          ...existing,
          describeTriggerAction(target),
        ]);

        triggerIdField.set("");
      },
    )({ savedSubscriptions, triggerLog, triggerIdField });

    const name = str`Search Subscriptions`;

    const subscriptionCards = lift(
      (subs: SavedSearchSubscription[]) => {
        const cards = [];
        for (const sub of subs) {
          const channelBadges = [];
          for (const channel of sub.channels) {
            channelBadges.push(
              h("span", {
                style:
                  "display: inline-block; background: #059669; color: white; " +
                  "padding: 2px 8px; border-radius: 4px; font-size: 11px; " +
                  "font-weight: 600; margin-right: 4px; text-transform: uppercase;",
              }, titleCase(channel)),
            );
          }

          const freqColor = sub.frequency === "daily"
            ? "#dc2626"
            : sub.frequency === "weekly"
            ? "#f59e0b"
            : "#3b82f6";

          cards.push(
            h("div", {
              style: "background: white; border: 1px solid #e5e7eb; " +
                "border-radius: 8px; padding: 16px; margin-bottom: 12px;",
            }, [
              h("div", {
                style: "display: flex; justify-content: space-between; " +
                  "align-items: start; margin-bottom: 8px;",
              }, [
                h("h3", {
                  style:
                    "margin: 0 0 4px 0; font-size: 16px; font-weight: 600; " +
                    "color: #111827;",
                }, sub.name),
                h("span", {
                  style: "display: inline-block; background: " + freqColor +
                    "; " +
                    "color: white; padding: 4px 10px; border-radius: 6px; " +
                    "font-size: 11px; font-weight: 700; text-transform: uppercase;",
                }, sub.frequency),
              ]),
              h("div", {
                style:
                  "font-family: monospace; font-size: 13px; color: #6b7280; " +
                  "background: #f9fafb; padding: 8px; border-radius: 4px; " +
                  "margin-bottom: 8px; border-left: 3px solid #3b82f6;",
              }, '"' + sub.query + '"'),
              h("div", {
                style: "display: flex; align-items: center; gap: 8px;",
              }, [
                h("span", {
                  style: "font-size: 12px; color: #6b7280; font-weight: 500;",
                }, "Channels:"),
                ...channelBadges,
              ]),
              h("div", {
                style: "margin-top: 8px; font-size: 11px; color: #9ca3af; " +
                  "font-family: monospace;",
              }, "ID: " + sub.id),
            ]),
          );
        }
        return h("div", {}, ...cards);
      },
    )(sanitizedSubscriptions);

    const triggerHistory = lift((logs: string[]) => {
      const reversed = logs.slice().reverse();
      const limited = reversed.slice(0, 8);
      if (limited.length === 0) {
        return h("div", {
          style: "color: #9ca3af; font-style: italic; padding: 16px; " +
            "text-align: center;",
        }, "No triggers yet");
      }
      const items = [];
      for (const entry of limited) {
        items.push(
          h("div", {
            style: "padding: 8px 12px; border-left: 3px solid #10b981; " +
              "background: #f0fdf4; border-radius: 4px; margin-bottom: 6px; " +
              "font-size: 13px; color: #065f46;",
          }, entry),
        );
      }
      return h("div", {}, ...items);
    })(triggerLog);

    const ui = (
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh;">
        <div style="background: white; border-radius: 12px; padding: 24px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
          <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 2px solid #e5e7eb;">
            <span style="font-size: 32px;">🔔</span>
            <h1 style="margin: 0; font-size: 28px; font-weight: 700; color: #111827;">
              Search Subscriptions
            </h1>
          </div>

          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 16px; border-radius: 8px; margin-bottom: 24px; text-align: center;">
            <div style="font-size: 36px; font-weight: 700; margin-bottom: 4px;">
              {totalSubscriptions}
            </div>
            <div style="font-size: 14px; font-weight: 500; opacity: 0.9;">
              Active Subscriptions
            </div>
          </div>

          <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin-bottom: 24px; border: 1px solid #e5e7eb;">
            <h2 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #111827;">
              Add New Subscription
            </h2>
            <div style="display: grid; gap: 12px;">
              <div>
                <label style="display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 4px;">
                  Name
                </label>
                <ct-input
                  $value={nameField}
                  placeholder="e.g., Frontend Jobs"
                  style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;"
                />
              </div>
              <div>
                <label style="display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 4px;">
                  Search Query
                </label>
                <ct-input
                  $value={queryField}
                  placeholder="e.g., react developer remote"
                  style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;"
                />
              </div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                <div>
                  <label style="display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 4px;">
                    Frequency
                  </label>
                  <ct-input
                    $value={frequencyField}
                    placeholder="daily, weekly, or monthly"
                    style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;"
                  />
                </div>
                <div>
                  <label style="display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 4px;">
                    Channels (comma-separated)
                  </label>
                  <ct-input
                    $value={channelsField}
                    placeholder="email, push, sms"
                    style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;"
                  />
                </div>
              </div>
              <ct-button
                onClick={addSubscriptionUi}
                style="background: #10b981; color: white; padding: 10px 20px; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 14px;"
              >
                Add Subscription
              </ct-button>
            </div>
          </div>

          <div style="margin-bottom: 24px;">
            <h2 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #111827;">
              Your Subscriptions
            </h2>
            {subscriptionCards}
          </div>

          <div style="background: #fef3c7; padding: 20px; border-radius: 8px; margin-bottom: 24px; border: 1px solid #fbbf24;">
            <h2 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #92400e;">
              Trigger Searches
            </h2>
            <div style="display: grid; gap: 12px;">
              <ct-button
                onClick={triggerAllUi}
                style="background: #f59e0b; color: white; padding: 12px 20px; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 14px;"
              >
                Trigger All Subscriptions
              </ct-button>
              <div style="display: grid; grid-template-columns: 1fr auto; gap: 12px;">
                <ct-input
                  $value={triggerIdField}
                  placeholder="Enter subscription ID or name"
                  style="padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;"
                />
                <ct-button
                  onClick={triggerOneUi}
                  style="background: #f59e0b; color: white; padding: 8px 20px; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 14px; white-space: nowrap;"
                >
                  Trigger One
                </ct-button>
              </div>
            </div>
          </div>

          <div>
            <h2 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #111827;">
              Recent Triggers
            </h2>
            {triggerHistory}
          </div>
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      subscriptions: sanitizedSubscriptions,
    };
  },
);
