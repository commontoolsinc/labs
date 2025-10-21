/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  derive,
  fetchData,
  handler,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";
import { type FeedItem, parseRSSFeed } from "./rss-utils.ts";

interface Settings {
  feedUrl: Default<string, "">;
  limit: Default<number, 100>;
}

const feedUpdater = handler<never, {
  items: Cell<FeedItem[]>;
  settings: Settings;
}>((_, { items, settings }) => {
  if (!settings.feedUrl) {
    console.warn("no feed URL provided");
    return;
  }

  const query = fetchData({ url: settings.feedUrl, mode: "text" });
  return derive(
    { items, query, limit: settings.limit },
    ({ query, limit, items }) => {
      if (!query.result || typeof query.result !== "string") return;
      const newEntries = parseRSSFeed(
        query.result as string,
        limit,
        new Set(items.get().map((item) => item.id)),
      );
      items.push(...newEntries);
    },
  );
});

export default recipe<
  { settings: Default<Settings, { feedUrl: ""; limit: 100 }> }
>(
  "rss importer",
  ({ settings }) => {
    const items = cell<FeedItem[]>([]);

    console.log("feed items", items.length);

    return {
      [NAME]: str`RSS/Atom Feed Importer ${settings.feedUrl}`,
      [UI]: (
        <div
          style={{
            display: "flex",
            gap: "10px",
            flexDirection: "column",
            padding: "25px",
          }}
        >
          <h2 style={{ fontSize: "20px", fontWeight: "bold" }}>
            Feed Items: {items.length}
          </h2>

          <common-hstack gap="sm">
            <common-vstack gap="sm">
              <div>
                <label>Feed URL</label>
                <ct-input
                  customStyle="border: 1px solid black; padding: 15px 10px; border-radius: 25px; min-width: 650px;"
                  $value={settings.feedUrl}
                  placeholder="https://example.com/feed.xml or https://example.com/atom.xml"
                />
              </div>
              <common-updater $state={settings} integration="rss" />
            </common-vstack>
          </common-hstack>
          <div>
            <table>
              <thead>
                <tr>
                  <th style={{ padding: "10px" }}>DATE</th>
                  <th style={{ padding: "10px" }}>TITLE</th>
                  <th style={{ padding: "10px" }}>AUTHOR</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr>
                    <td style={{ border: "1px solid black", padding: "10px" }}>
                      &nbsp;{item.pubDate}&nbsp;
                    </td>
                    <td style={{ border: "1px solid black", padding: "10px" }}>
                      &nbsp;{item.title}&nbsp;
                    </td>
                    <td style={{ border: "1px solid black", padding: "10px" }}>
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
