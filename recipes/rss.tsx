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
          description: "RSS/Atom feed URL",
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
  description: "RSS/Atom Feed Importer",
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

    // Helper function to extract content from XML tags
    const getContent = (str: string, tag: string) => {
      const regex = new RegExp(`<${tag}[^>]*>(.*?)<\/${tag}>`, "s");
      const match = str.match(regex);
      return match ? match[1].trim() : "";
    };

    // Helper to get an attribute value from a tag
    const getAttribute = (str: string, tag: string, attr: string) => {
      const regex = new RegExp(`<${tag}[^>]*${attr}=["']([^"']*)["'][^>]*>`, "i");
      const match = str.match(regex);
      return match ? match[1] : "";
    };

    // Detect feed type (RSS or Atom)
    const isAtom = text.includes("<feed") && text.includes("xmlns=\"http://www.w3.org/2005/Atom\"");
    
    const items: FeedItem[] = [];
    
    if (isAtom) {
      // Parse Atom feed
      const entryRegex = /<entry[\s\S]*?<\/entry>/g;
      const entryMatches = text.match(entryRegex) || [];

      entryMatches.slice(0, maxResults).forEach((entryStr) => {
        // In Atom, id is mandatory
        const id = getContent(entryStr, "id") || Math.random().toString(36);

        // Skip if we already have this item
        if (state.items.get().some((item) => item.id === id)) {
          return;
        }

        // Parse link - in Atom links are elements with href attributes
        let link = "";
        const linkMatch = entryStr.match(/<link[^>]*href=["']([^"']*)["'][^>]*>/);
        if (linkMatch) {
          link = linkMatch[1];
        }

        // For content, check content tag first, then summary
        const content = getContent(entryStr, "content") || getContent(entryStr, "summary");
        
        // For author, it might be nested as <author><name>Author</name></author>
        let author = "";
        if (entryStr.includes("<author>")) {
          author = getContent(getContent(entryStr, "author"), "name");
        }

        // For pubDate, Atom uses <published> or <updated>
        const pubDate = getContent(entryStr, "published") || 
                        getContent(entryStr, "updated");

        items.push({
          id,
          title: getContent(entryStr, "title"),
          link,
          description: getContent(entryStr, "summary"),
          pubDate,
          author,
          content,
        });
      });
    } else {
      // Parse RSS feed (original implementation)
      const itemRegex = /<item[\s\S]*?<\/item>/g;
      const itemMatches = text.match(itemRegex) || [];

      itemMatches.slice(0, maxResults).forEach((itemStr) => {
        const id = getContent(itemStr, "guid") ||
          getContent(itemStr, "link") ||
          Math.random().toString(36);

        if (state.items.get().some((item) => item.id === id)) {
          return;
        }

        items.push({
          id,
          title: getContent(itemStr, "title"),
          link: getContent(itemStr, "link"),
          description: getContent(itemStr, "description"),
          pubDate: getContent(itemStr, "pubDate"),
          author: getContent(itemStr, "author"),
          content: getContent(itemStr, "content:encoded") ||
            getContent(itemStr, "description"),
        });
      });
    }

    if (items.length > 0) {
      items.forEach((item) => {
        item[ID] = item.id;
      });
      state.items.push(...items);
    }

    return { items };
  } catch (error) {
    console.error("Error fetching feed:", error);
    return { items: [] };
  }
}

const feedUpdater = handler(
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
      [NAME]: str`RSS/Atom Feed Importer ${settings.feedUrl}`,
      [UI]: (
        <div style="display: flex; gap: 10px; flex-direction: column; padding: 25px;">
          <h2 style="font-size: 20px; font-weight: bold;">
            Feed Items: {derive(items, (items) => items.length)}
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
                  placeholder="https://example.com/feed.xml or https://example.com/atom.xml"
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
      rssUpdater: feedUpdater({ items, settings }),
    };
  },
);
