import { h } from "@commontools/html";
import {
    cell,
    derive,
    handler,
    ID,
    JSONSchema,
    NAME,
    recipe,
    Schema,
    str,
    UI,
} from "@commontools/builder";
import { Cell } from "@commontools/runner";

const FeedItemProperties = {
    id: { type: "string" },
    title: { type: "string" },
    link: { type: "string" },
    description: { type: "string" },
    pubDate: { type: "string" },
    author: { type: "string" },
    content: { type: "string" },
} as const;

const FeedItemSchema = {
    type: "object",
    properties: FeedItemProperties,
    required: Object.keys(FeedItemProperties),
} as const satisfies JSONSchema;
type FeedItem = Schema<typeof FeedItemSchema>;

const RSSImporterInputs = {
    type: "object",
    properties: {
        settings: {
            type: "object",
            properties: {
                feedUrl: {
                    type: "string",
                    description: "RSS feed URL",
                    default: "",
                },
                limit: {
                    type: "number",
                    description: "number of items to import",
                    default: 100,
                },
            },
            required: ["feedUrl", "limit"],
        },
    },
    required: ["settings"],
    description: "RSS Feed Importer",
} as const satisfies JSONSchema;

const ResultSchema = {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: FeedItemProperties,
            },
        },
        rssUpdater: { asStream: true, type: "object", properties: {} },
    },
} as const satisfies JSONSchema;

const updateLimit = handler({
    type: "object",
    properties: {
        detail: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
        },
    },
}, {
    type: "object",
    properties: { limit: { type: "number", asCell: true } },
    required: ["limit"],
}, ({ detail }, state) => {
    state.limit.set(parseInt(detail?.value ?? "100") || 0);
});

const updateFeedUrl = handler<
    { detail: { value: string } },
    { feedUrl: string }
>(
    ({ detail }, state) => {
        state.feedUrl = detail?.value ?? "";
    },
);

async function fetchRSSFeed(
    feedUrl: string,
    maxResults: number = 100,
    state: {
        items: Cell<FeedItem[]>;
    },
) {
    try {
        const response = await fetch(feedUrl);
        const text = await response.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(text, "text/xml");

        const items = Array.from(xmlDoc.querySelectorAll("item")).slice(
            0,
            maxResults,
        );
        const existingItemIds = new Set(
            state.items.get().map((item) => item.id),
        );

        const newItems = items.map((item) => {
            const id = item.querySelector("guid")?.textContent ||
                item.querySelector("link")?.textContent ||
                Math.random().toString(36);

            if (existingItemIds.has(id)) return null;

            return {
                id,
                title: item.querySelector("title")?.textContent || "",
                link: item.querySelector("link")?.textContent || "",
                description: item.querySelector("description")?.textContent ||
                    "",
                pubDate: item.querySelector("pubDate")?.textContent || "",
                author: item.querySelector("author")?.textContent || "",
                content: item.querySelector("content\\:encoded")?.textContent ||
                    item.querySelector("description")?.textContent || "",
            } as FeedItem;
        }).filter((item): item is FeedItem => item !== null);

        if (newItems.length > 0) {
            newItems.forEach((item) => {
                item[ID] = item.id;
            });
            state.items.push(...newItems);
        }

        return { items: newItems };
    } catch (error) {
        console.error("Error fetching RSS feed:", error);
        return { items: [] };
    }
}

const rssUpdater = handler(
    {},
    {
        type: "object",
        properties: {
            items: {
                type: "array",
                items: FeedItemSchema,
                default: [],
                asCell: true,
            },
            settings: RSSImporterInputs.properties.settings,
        },
        required: ["items", "settings"],
    } as const satisfies JSONSchema,
    (_event, state) => {
        if (!state.settings.feedUrl) {
            console.warn("no feed URL provided");
            return;
        }

        fetchRSSFeed(
            state.settings.feedUrl,
            state.settings.limit,
            state,
        );
    },
);

export default recipe(
    RSSImporterInputs,
    ResultSchema,
    (state) => {
        const { settings } = state;
        const items = cell<FeedItem[]>([]);

        derive(items, (items) => {
            console.log("feed items", items.length);
        });

        return {
            [NAME]: str`RSS Feed Importer ${settings.feedUrl}`,
            [UI]: (
                <div style="display: flex; gap: 10px; flex-direction: column; padding: 25px;">
                    <h2 style="font-size: 20px; font-weight: bold;">
                        RSS Feed Items: {derive(items, (items) => items.length)}
                    </h2>

                    <common-hstack gap="sm">
                        <common-vstack gap="sm">
                            <div>
                                <label>Import Limit</label>
                                <common-input
                                    customStyle="border: 1px solid black; padding: 15px 10px; border-radius: 25px; min-width: 650px;"
                                    value={settings.limit}
                                    placeholder="number of items to import"
                                    oncommon-input={updateLimit({
                                        limit: settings.limit,
                                    })}
                                />
                            </div>

                            <div>
                                <label>Feed URL</label>
                                <common-input
                                    customStyle="border: 1px solid black; padding: 15px 10px; border-radius: 25px; min-width: 650px;"
                                    value={settings.feedUrl}
                                    placeholder="https://example.com/feed.xml"
                                    oncommon-input={updateFeedUrl({
                                        feedUrl: settings.feedUrl,
                                    })}
                                />
                            </div>
                            <common-updater $state={state} integration="rss" />
                        </common-vstack>
                    </common-hstack>
                    <div>
                        <table>
                            <thead>
                                <tr>
                                    <th style="padding: 10px;">DATE</th>
                                    <th style="padding: 10px;">TITLE</th>
                                    <th style="padding: 10px;">AUTHOR</th>
                                </tr>
                            </thead>
                            <tbody>
                                {items.map((item) => (
                                    <tr>
                                        <td style="border: 1px solid black; padding: 10px;">
                                            &nbsp;{item.pubDate}&nbsp;
                                        </td>
                                        <td style="border: 1px solid black; padding: 10px;">
                                            &nbsp;{item.title}&nbsp;
                                        </td>
                                        <td style="border: 1px solid black; padding: 10px;">
                                            &nbsp;{item.author}&nbsp;
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            ),
            items,
            bgUpdater: rssUpdater({ items, settings }),
        };
    },
);
