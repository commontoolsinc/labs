/// <cts-enable />

import {
  type Cell,
  cell,
  Default,
  h,
  handler,
  ID,
  NAME,
  recipe,
  UI,
} from "commontools";
import { DOMParser, type Element } from "dom-parser";

interface Settings {
  feedUrl: Default<string, "">;
  limit: Default<number, 100>;
}

type FeedItem = {
  id: string;
  title: string;
  link: string;
  description: string;
  pubDate: string;
  author: string;
  content: string;
};

const updateLimit = handler<
  { detail: { value: string } },
  { limit: Cell<number> }
>(({ detail }, { limit }) => {
  limit.set(parseInt(detail?.value ?? "100") || 0);
});

const updateFeedUrl = handler<
  { detail: { value: string } },
  { feedUrl: Cell<string> }
>(
  ({ detail }, { feedUrl }) => {
    feedUrl.set(detail?.value ?? "");
  },
);

async function fetchRSSFeed(
  feedUrl: string,
  maxResults: number = 100,
  currentItems: Cell<FeedItem[]>,
) {
  const response = await fetch(feedUrl);
  const text = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "text/xml");

  // Helper function to get text content from an element
  const getTextContent = (element: Element | null, tagName: string) => {
    const el = element?.getElementsByTagName(tagName)[0];
    return el?.textContent?.trim() || "";
  };

  // Helper function to get attribute value
  const getAttributeValue = (
    element: Element | null,
    tagName: string,
    attrName: string,
  ) => {
    const el = element?.getElementsByTagName(tagName)[0];
    return el?.getAttribute(attrName) || "";
  };

  const retreivedItems: FeedItem[] = [];

  // Check if it's an Atom feed
  const isAtom = doc.querySelector("feed") !== null;

  if (isAtom) {
    // Parse Atom feed
    const entries = doc.getElementsByTagName("entry");

    for (let i = 0; i < Math.min(entries.length, maxResults); i++) {
      const entry = entries[i];

      // In Atom, id is mandatory
      const id = getTextContent(entry, "id") || Math.random().toString(36);

      // Skip if we already have this item
      if (currentItems.get().some((item) => item.id === id)) {
        continue;
      }

      // Parse link - in Atom links are elements with href attributes
      const link = getAttributeValue(entry, "link", "href");

      // For content, check content tag first, then summary
      const content = getTextContent(entry, "content") ||
        getTextContent(entry, "summary");

      // For author, it might be nested as <author><name>Author</name></author>
      let author = "";
      const authorEl = entry.getElementsByTagName("author")[0];
      if (authorEl) {
        author = getTextContent(authorEl, "name");
      }

      // For pubDate, Atom uses <published> or <updated>
      const pubDate = getTextContent(entry, "published") ||
        getTextContent(entry, "updated");

      retreivedItems.push({
        id,
        title: getTextContent(entry, "title"),
        link,
        description: getTextContent(entry, "summary"),
        pubDate,
        author,
        content,
      });
    }
  } else {
    // Parse RSS feed
    const rssItems = doc.getElementsByTagName("item");

    for (let i = 0; i < Math.min(rssItems.length, maxResults); i++) {
      const item = rssItems[i];

      const id = getTextContent(item, "guid") ||
        getTextContent(item, "link") ||
        Math.random().toString(36);

      if (currentItems.get().some((existingItem) => existingItem.id === id)) {
        continue;
      }

      retreivedItems.push({
        id,
        title: getTextContent(item, "title"),
        link: getTextContent(item, "link"),
        description: getTextContent(item, "description"),
        pubDate: getTextContent(item, "pubDate"),
        author: getTextContent(item, "author"),
        content: getTextContent(item, "content:encoded") ||
          getTextContent(item, "description"),
      });
    }
  }

  if (retreivedItems.length > 0) {
    retreivedItems.forEach((item) => {
      (item as any)[ID] = item.id; // FIXME(ja): how to do this better?
    });
    currentItems.push(...retreivedItems);
  }
}

const feedUpdater = handler<unknown, {
  items: Cell<FeedItem[]>;
  settings: Settings;
}>(async (_event, { settings, items }) => {
  if (!settings.feedUrl) {
    console.warn("no feed URL provided");
    return;
  }

  return await fetchRSSFeed(
    settings.feedUrl,
    settings.limit,
    items,
  );
});

export default recipe<{ settings: Settings }>(
  "rss importer",
  ({ settings }) => {
    const items = cell<FeedItem[]>([]);

    console.log("feed items", items.length);

    return {
      [NAME]: `RSS/Atom Feed Importer ${settings.feedUrl}`,
      [UI]: (
        <div style="display: flex; gap: 10px; flex-direction: column; padding: 25px;">
          <h2 style="font-size: 20px; font-weight: bold;">
            Feed Items: {items.length}
          </h2>

          <common-hstack gap="sm">
            <common-vstack gap="sm">
              <div>
                <label>Import Limit</label>
                <common-input
                  customStyle="border: 1px solid black; padding: 15px 10px; border-radius: 25px; min-width: 650px;"
                  value={settings.limit}
                  placeholder="number of items to import"
                  oncommon-input={updateLimit({ limit: settings.limit })}
                />
              </div>

              <div>
                <label>Feed URL</label>
                <common-input
                  customStyle="border: 1px solid black; padding: 15px 10px; border-radius: 25px; min-width: 650px;"
                  value={settings.feedUrl}
                  placeholder="https://example.com/feed.xml or https://example.com/atom.xml"
                  oncommon-input={updateFeedUrl({ feedUrl: settings.feedUrl })}
                />
              </div>
              <common-updater $state={settings} integration="rss" />
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
      bgUpdater: feedUpdater({ items, settings }),
    };
  },
);
