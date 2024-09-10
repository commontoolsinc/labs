import { db } from "./db.ts";

export function printItem(itemId: number, showRaw: boolean = false) {
  const item = db.query<
    [number, string, string, string, string, string, string]
  >(
    "SELECT id, url, title, content, raw_content, source, created_at FROM items WHERE id = ?",
    [itemId]
  )[0];

  if (!item) {
    console.log(`Item with ID ${itemId} not found.`);
    return;
  }

  const [id, url, title, content, rawContent, source, createdAt] = item;

  console.log(`Item ID: ${id}`);
  console.log(`URL: ${url}`);
  console.log(`Title: ${title}`);
  console.log(`Source: ${source}`);
  console.log(`Created At: ${createdAt}`);
  console.log("\nContent:");

  try {
    const contentObj = JSON.parse(content);
    console.log(JSON.stringify(contentObj, null, 2));
  } catch (error) {
    console.log("Error parsing JSON content:", error.message);
    console.log("Raw content:", content);
  }

  if (showRaw) {
    console.log("\nRaw Content:");
    console.log(rawContent);
  }

  // Print associated collections
  const collections = db.query<[string]>(
    `SELECT c.name 
     FROM collections c
     JOIN item_collections ic ON c.id = ic.collection_id
     WHERE ic.item_id = ?`,
    [itemId]
  );

  if (collections.length > 0) {
    console.log("\nAssociated Collections:");
    collections.forEach(([name]) => console.log(`- ${name}`));
  }
}
