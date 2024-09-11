import { getOrCreateCollection } from "./collections.ts";
import { db } from "./db.ts";
import { parseFeed } from "./deps.ts";

export async function clipRSS(url: string, collectionName: string) {
  try {
    const response = await fetch(url);
    const xml = await response.text();
    const feed = await parseFeed(xml);

    db.query("BEGIN TRANSACTION");

    const collectionId = await getOrCreateCollection(collectionName);
    let itemCount = 0;

    for (const item of feed.entries) {
      const contentJson: Record<string, unknown> = {};

      // Extract all key-value pairs from the item
      for (const [key, value] of Object.entries(item)) {
        if (typeof value === "object" && value !== null) {
          if ("value" in value) {
            contentJson[key] = value.value;
          } else {
            contentJson[key] = value;
          }
        } else {
          contentJson[key] = value;
        }
      }

      const result = db.query(
        "INSERT INTO items (url, title, content, raw_content, source) VALUES (?, ?, ?, ?, ?) RETURNING id",
        [
          item.links[0].href,
          item.title?.value,
          JSON.stringify(contentJson),
          item.description?.value || "",
          "RSS",
        ],
      );
      const itemId = result[0][0] as number;

      db.query(
        "INSERT INTO item_collections (item_id, collection_id) VALUES (?, ?)",
        [itemId, collectionId],
      );

      itemCount++;
    }

    db.query("COMMIT");

    console.log(
      `Clipped ${itemCount} items from RSS feed to collection: ${collectionName}`,
    );
  } catch (error) {
    db.query("ROLLBACK");
    console.error(`Error clipping RSS feed: ${error.message}`);
  }
}
